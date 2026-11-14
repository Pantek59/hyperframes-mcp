/**
 * fish-audio.js — Fish Audio S2 voice-cloning TTS runner backed by ComfyUI.
 *
 * Flow: read the narration text + reference voice assets from the project,
 * upload the reference into ComfyUI's input dir, submit the API-format
 * workflow (POST /prompt), poll /history until done, download the produced
 * audio via /view, validate it and publish it next to the text asset as a
 * non-replacing per-job artifact (same semantics as the Higgs runner).
 *
 * The built-in template mirrors the deployment-tested Fish S2 voice-clone
 * workflow. A custom workflow (ComfyUI API format) can replace it through
 * FISH_AUDIO_WORKFLOW_JSON; it must contain a Fish TTS node and a LoadAudio
 * node, whose `text` / `reference_text` / `language` widgets get overridden.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createComfyClient, getComfyConfig } from "./comfyui.js";
import {
  publishAssetOutput,
  readText,
  resolveAssetInput,
} from "./asset-ops.js";

const DEFAULT_MAX_TEXT_BYTES = 64 * 1024;
const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_WORKFLOW_BYTES = 1024 * 1024;

// keep_model_loaded stays on: reloading the S2 model per job is far too slow.
const DEFAULT_WORKFLOW = {
  "1": {
    inputs: {
      model_path: "s2-pro-fp8 (auto download)",
      text: "",
      language: "de",
      device: "cuda",
      precision: "bfloat16",
      attention: "sdpa",
      max_new_tokens: 1024,
      chunk_length: 400,
      temperature: 0.8,
      top_p: 0.8,
      repetition_penalty: 1.1,
      seed: 603031055,
      keep_model_loaded: true,
      offload_to_cpu: false,
      compile_model: false,
      reference_text: "",
      reference_audio: ["2", 0],
    },
    _meta: { title: "Fish S2 Voice Clone TTS" },
    class_type: "FishS2VoiceCloneTTS",
  },
  "2": {
    inputs: {
      audio: "",
    },
    _meta: { title: "Load Audio" },
    class_type: "LoadAudio",
  },
  "3": {
    inputs: {
      audio: ["1", 0],
    },
    _meta: { title: "Preview Audio" },
    class_type: "PreviewAudio",
  },
};

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getFishAudioConfig(env = process.env) {
  return {
    language: String(env.FISH_AUDIO_LANGUAGE || "de").trim(),
    modelPath: String(env.FISH_AUDIO_MODEL_PATH || "").trim(),
    workflowJsonPath: String(env.FISH_AUDIO_WORKFLOW_JSON || "").trim(),
    maxTextBytes: positiveInt(env.FISH_AUDIO_MAX_TEXT_BYTES, DEFAULT_MAX_TEXT_BYTES),
    maxAudioBytes: positiveInt(env.FISH_AUDIO_MAX_AUDIO_BYTES, DEFAULT_MAX_AUDIO_BYTES),
  };
}

async function loadWorkflowTemplate(config) {
  if (!config.workflowJsonPath) return DEFAULT_WORKFLOW;
  let raw;
  try {
    const stat = await fs.stat(config.workflowJsonPath);
    if (!stat.isFile() || stat.size > MAX_WORKFLOW_BYTES) {
      throw new Error("missing, not a regular file, or larger than 1 MiB");
    }
    raw = await fs.readFile(config.workflowJsonPath, "utf8");
  } catch (error) {
    throw new Error(`FISH_AUDIO_WORKFLOW_JSON is unusable: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FISH_AUDIO_WORKFLOW_JSON must contain valid ComfyUI API-format workflow JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("FISH_AUDIO_WORKFLOW_JSON must be a ComfyUI API-format workflow object");
  }
  for (const node of Object.values(parsed)) {
    if (!node || typeof node !== "object" || typeof node.class_type !== "string") {
      throw new Error("FISH_AUDIO_WORKFLOW_JSON nodes must each define a class_type string");
    }
  }
  return parsed;
}

/**
 * Locate the Fish TTS node and the LoadAudio node and inject the job's
 * parameters. Only string widgets are overridden so linked inputs in custom
 * workflows are left intact.
 */
function buildWorkflow({ template, uploadedFilename, text, language, referenceText, modelPath }) {
  const workflow = structuredClone(template);
  let ttsNode = null;
  let audioNode = null;
  for (const node of Object.values(workflow)) {
    if (node.class_type === "LoadAudio" && !audioNode) audioNode = node;
    else if (/^Fish/i.test(node.class_type) && !ttsNode) ttsNode = node;
  }
  if (!ttsNode || !audioNode) {
    throw new Error("ComfyUI workflow must contain a Fish TTS node and a LoadAudio node");
  }
  audioNode.inputs.audio = uploadedFilename;
  const inputs = ttsNode.inputs;
  if (typeof inputs.text !== "string") throw new Error("Fish TTS node must expose a string text widget");
  inputs.text = text;
  if (typeof inputs.reference_text === "string") inputs.reference_text = referenceText;
  if (typeof inputs.language === "string") inputs.language = language;
  if (modelPath && typeof inputs.model_path === "string") inputs.model_path = modelPath;
  return workflow;
}

function validateAudio({ buffer, filename }) {
  const extension = String(filename).toLowerCase().split(".").pop();
  if (extension === "flac") {
    if (buffer.length < 4 || buffer.toString("ascii", 0, 4) !== "fLaC") {
      throw new Error("ComfyUI returned an invalid FLAC file");
    }
    return ".flac";
  }
  if (extension === "wav") {
    if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" ||
        buffer.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("ComfyUI returned an invalid WAV file");
    }
    return ".wav";
  }
  throw new Error(`ComfyUI produced an unsupported audio format: .${extension || "unknown"}`);
}

export function createFishAudioRunner({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async (job, { workspace, signal }) => {
    const comfy = getComfyConfig(env);
    const config = getFishAudioConfig(env);
    const client = createComfyClient({ baseUrl: comfy.baseUrl, apiKey: comfy.apiKey, fetchImpl });

    const params = job.params || {};
    const filename = params.filename;
    const referenceFilename = params.reference_filename;
    const referenceText = typeof params.reference_text === "string" ? params.reference_text.trim() : "";
    if (!referenceFilename) {
      throw new Error("Fish Audio TTS requires reference_filename (relative to assets/)");
    }
    if (!referenceText) {
      throw new Error("Fish Audio TTS requires reference_text (the transcript of the reference audio)");
    }
    const language = typeof params.language === "string" && params.language.trim()
      ? params.language.trim().toLowerCase()
      : config.language;

    const projectDir = path.resolve(workspace, job.project || ".");
    const input = await resolveAssetInput({ workspace, projectDir, filename });
    const text = await readText(input.path, config.maxTextBytes);
    if (signal.aborted) throw signal.reason || new Error("Job canceled");
    const template = await loadWorkflowTemplate(config);

    const reference = await resolveAssetInput({ workspace, projectDir, filename: referenceFilename });
    if (reference.stat.size > config.maxAudioBytes) {
      throw new Error(`Reference audio exceeds the ${config.maxAudioBytes}-byte limit`);
    }
    const referenceBytes = await fs.readFile(reference.path);
    if (referenceBytes.length !== reference.stat.size) {
      throw new Error("Reference audio changed while the job was running");
    }
    if (signal.aborted) throw signal.reason || new Error("Job canceled");

    const upload = await client.uploadFile({
      buffer: referenceBytes,
      filename: referenceFilename.split("/").pop(),
      signal,
    });
    if (signal.aborted) throw signal.reason || new Error("Job canceled");

    const promptId = await client.submitWorkflow({
      workflow: buildWorkflow({
        template,
        uploadedFilename: upload.filename,
        text,
        language,
        referenceText,
        modelPath: config.modelPath,
      }),
      signal,
    });
    const outputs = await client.waitForCompletion({ promptId, signal });

    const audioItems = [];
    for (const nodeOutput of Object.values(outputs)) {
      if (nodeOutput && Array.isArray(nodeOutput.audio)) audioItems.push(...nodeOutput.audio);
    }
    if (audioItems.length === 0) throw new Error("ComfyUI workflow produced no audio output");
    const produced = audioItems[0];
    if (typeof produced?.filename !== "string" || !produced.filename) {
      throw new Error("ComfyUI workflow returned an unnamed audio output");
    }
    const audio = await client.fetchOutput({
      filename: produced.filename,
      subfolder: produced.subfolder,
      type: produced.type,
      maxBytes: config.maxAudioBytes,
      signal,
    });
    const extension = validateAudio({ buffer: audio, filename: produced.filename });
    if (signal.aborted) throw signal.reason || new Error("Job canceled");

    const output = await publishAssetOutput({
      workspace,
      projectDir,
      filename,
      jobId: job.id,
      extension,
      bytes: audio,
      inputPath: input.path,
      signal,
    });
    return {
      artifacts: [output.artifactPath],
      cleanup: output.cleanup,
    };
  };
}
