import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFishAudioRunner } from "../src/fish-audio.js";

const BASE_ENV = {
  COMFYUI_API_KEY: "test-key",
  FISH_AUDIO_LANGUAGE: "de",
};

function makeFlac() {
  const flac = Buffer.alloc(64);
  flac.write("fLaC", 0, "ascii");
  return flac;
}

function reply(response, status, text) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}

async function startComfy(t, state) {
  const historyId = "p-1";
  const service = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(request.url, "http://localhost");
    state.requests.push({ method: request.method, url: request.url, auth: request.headers.authorization });
    try {
      if (request.method === "POST" && url.pathname === "/upload/image") {
        state.uploads.push(body);
        if (state.uploadStatus) return reply(response, state.uploadStatus, "{}");
        return reply(response, 200, JSON.stringify({ name: "renamed.m4a", subfolder: "", type: "input" }));
      }
      if (request.method === "POST" && url.pathname === "/prompt") {
        state.prompts.push(JSON.parse(body.toString("utf8")));
        if (state.promptStatus) return reply(response, state.promptStatus, '{"node_errors":{}}');
        return reply(response, 200, JSON.stringify({ prompt_id: historyId, node_errors: {} }));
      }
      if (request.method === "GET" && url.pathname === `/history/${historyId}`) {
        state.historyRequests += 1;
        if (state.pendingForever) return reply(response, 200, "{}");
        const outputs = state.historyOutputs ?? {
          "3": { audio: [{ filename: "audio_preview_00001_.flac", subfolder: "", type: "temp" }] },
        };
        const status = state.historyStatus ?? "success";
        return reply(response, 200, JSON.stringify({
          [historyId]: {
            prompt: [],
            outputs,
            status: { status_str: status, completed: status === "success", messages: [] },
          },
        }));
      }
      if (request.method === "GET" && url.pathname === "/view") {
        state.viewRequests += 1;
        state.viewed = {
          filename: url.searchParams.get("filename"),
          type: url.searchParams.get("type"),
          subfolder: url.searchParams.get("subfolder"),
        };
        if (state.viewStatus) return reply(response, state.viewStatus, "{}");
        response.writeHead(200, { "content-type": "application/octet-stream" });
        return response.end(state.viewBytes ?? makeFlac());
      }
      return reply(response, 404, "{}");
    } catch (error) {
      return reply(response, 500, JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  const { port } = service.address();
  t.after(() => new Promise((resolve, reject) => service.close((error) => error ? reject(error) : resolve())));
  return {
    env: { ...BASE_ENV, COMFYUI_BASE_URL: `http://127.0.0.1:${port}` },
    state,
  };
}
function freshState() {
  return {
    requests: [],
    uploads: [],
    prompts: [],
    historyRequests: 0,
    viewRequests: 0,
  };
}

async function makeInput(t, text = "Hello from a project asset.") {
  const workspace = await mkdtemp(path.join(tmpdir(), "hf-fish-"));
  const narrationDir = path.join(workspace, "project", "assets", "narration");
  const voiceDir = path.join(workspace, "project", "assets", "voice");
  await mkdir(narrationDir, { recursive: true });
  await mkdir(voiceDir, { recursive: true });
  await writeFile(path.join(narrationDir, "script.txt"), text);
  await writeFile(path.join(voiceDir, "speaker.m4a"), "VOICEREF-AUDIO-BYTES");
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return { workspace, narrationDir };
}

function job(id = "job-test", params = {}) {
  return {
    id,
    project: "project",
    params: {
      filename: "narration/script.txt",
      reference_filename: "voice/speaker.m4a",
      reference_text: "Transcript of the reference recording.",
      language: "de",
      ...params,
    },
  };
}

test("uploads the reference, injects parameters and publishes the job's FLAC", async (t) => {
  const { env, state } = await startComfy(t, freshState());
  const { workspace, narrationDir } = await makeInput(t);
  const runner = createFishAudioRunner({ env });

  const result = await runner(job(), { workspace, signal: new AbortController().signal });

  assert.deepEqual(result.artifacts, ["assets/narration/script.job-test.flac"]);
  assert.equal(state.prompts.length, 1);
  assert.equal(state.viewRequests, 1);
  assert.deepEqual(state.viewed, { filename: "audio_preview_00001_.flac", type: "temp", subfolder: "" });
  assert.equal(state.prompts[0].client_id.length, 36);
  const workflow = state.prompts[0].prompt;
  assert.deepEqual(workflow["1"].inputs.reference_audio, ["2", 0]);
  assert.deepEqual(workflow["3"].inputs.audio, ["1", 0]);
  assert.equal(workflow["2"].inputs.audio, "renamed.m4a");
  assert.equal(workflow["1"].inputs.text, "Hello from a project asset.");
  assert.equal(workflow["1"].inputs.language, "de");
  assert.equal(workflow["1"].inputs.reference_text, "Transcript of the reference recording.");
  assert.equal(workflow["1"].inputs.keep_model_loaded, true);
  assert.ok(state.uploads[0].includes('name="image"; filename="speaker.m4a"'));
  assert.ok(state.uploads[0].includes('name="overwrite"\r\n\r\nfalse\r\n'));
  assert.ok(state.uploads[0].includes("VOICEREF-AUDIO-BYTES"));
  assert.deepEqual(await readFile(path.join(narrationDir, "script.job-test.flac")), makeFlac());
  assert.deepEqual((await readdir(narrationDir)).sort(), ["script.job-test.flac", "script.txt"]);
});

test("sends the configured bearer token on every request", async (t) => {
  const { env, state } = await startComfy(t, freshState());
  const { workspace } = await makeInput(t);
  const runner = createFishAudioRunner({ env });

  await runner(job(), { workspace, signal: new AbortController().signal });

  assert.deepEqual(state.requests.map((r) => r.auth), [
    "Bearer test-key", "Bearer test-key", "Bearer test-key", "Bearer test-key",
  ]);
});

test("rejects missing reference parameters before contacting ComfyUI", async (t) => {
  const { env, state } = await startComfy(t, freshState());
  const { workspace } = await makeInput(t);
  const runner = createFishAudioRunner({ env });

  await assert.rejects(
    () => runner(job("", { reference_filename: undefined }), { workspace, signal: new AbortController().signal }),
    /reference_filename/
  );
  await assert.rejects(
    () => runner(job("", { reference_text: "  " }), { workspace, signal: new AbortController().signal }),
    /reference_text/
  );
  assert.equal(state.requests.length, 0);
});

test("fails without artifacts when ComfyUI rejects the workflow", async (t) => {
    const { env, state } = await startComfy(t, { ...freshState(), promptStatus: 400 });
  const { workspace, narrationDir } = await makeInput(t);
  const runner = createFishAudioRunner({ env });

  await assert.rejects(
    () => runner(job(), { workspace, signal: new AbortController().signal }),
    /ComfyUI rejected the workflow/
  );
  assert.deepEqual((await readdir(narrationDir)).sort(), ["script.txt"]);
});

test("fails when the workflow execution ends in an error", async (t) => {
    const { env } = await startComfy(t, { ...freshState(), historyStatus: "error" });
  const { workspace } = await makeInput(t);
  const runner = createFishAudioRunner({ env });

  await assert.rejects(
    () => runner(job(), { workspace, signal: new AbortController().signal }),
    /execution error/
  );
});

test("fails when the workflow produces no audio output", async (t) => {
    const { env } = await startComfy(t, { ...freshState(), historyOutputs: {} });
  const { workspace } = await makeInput(t);
  const runner = createFishAudioRunner({ env });

  await assert.rejects(
    () => runner(job(), { workspace, signal: new AbortController().signal }),
    /no audio output/
  );
});

test("rejects unsupported or corrupted ComfyUI audio output", async (t) => {
  const { env } = await startComfy(t, {
    ...freshState(),
    historyOutputs: { "3": { audio: [{ filename: "audio.mp3", subfolder: "", type: "temp" }] } },
  });
  const { workspace } = await makeInput(t);
  const runner = createFishAudioRunner({ env });

  await assert.rejects(
    () => runner(job(), { workspace, signal: new AbortController().signal }),
    /unsupported audio format/
  );

  const corrupted = await startComfy(t, { ...freshState(), viewBytes: Buffer.from("not a flac", "utf8") });
  const inputs = await makeInput(t);
  const corruptedRunner = createFishAudioRunner({ env: corrupted.env });
  await assert.rejects(
    () => corruptedRunner(job(), { workspace: inputs.workspace, signal: new AbortController().signal }),
    /invalid FLAC/
  );
});

test("enforces the reference and download byte caps", async (t) => {
  const tight = await startComfy(t, freshState());
  const { workspace, narrationDir } = await makeInput(t);
  const runner = createFishAudioRunner({
    env: { ...tight.env, FISH_AUDIO_MAX_AUDIO_BYTES: "10" },
  });

  await assert.rejects(
    () => runner(job(), { workspace, signal: new AbortController().signal }),
    /Reference audio exceeds/
  );
  assert.equal(tight.state.requests.length, 0);
  assert.deepEqual((await readdir(narrationDir)).sort(), ["script.txt"]);

  const loose = await startComfy(t, freshState());
  const inputs = await makeInput(t);
  const looseRunner = createFishAudioRunner({
    env: { ...loose.env, FISH_AUDIO_MAX_AUDIO_BYTES: "32" },
  });
  await assert.rejects(
    () => looseRunner(job(), { workspace: inputs.workspace, signal: new AbortController().signal }),
    /response exceeds/
  );
});

test("aborts while waiting for history and leaves assets untouched", async (t) => {
  const { env, state } = await startComfy(t, { ...freshState(), pendingForever: true });
  const { workspace, narrationDir } = await makeInput(t);
  const runner = createFishAudioRunner({ env });
  const controller = new AbortController();
  const running = runner(job(), { workspace, signal: controller.signal });

  for (let attempt = 0; attempt < 200 && state.historyRequests === 0; attempt++) {
    await delay(5);
  }
  assert.ok(state.historyRequests > 0, "comfy history should have been polled");
  controller.abort(new Error("canceled by test"));

  await assert.rejects(running);
  assert.equal(state.viewRequests, 0);
  assert.deepEqual((await readdir(narrationDir)).sort(), ["script.txt"]);
});

test("fails an unconfigured Fish runner with an actionable message", async (t) => {
  const { workspace } = await makeInput(t);
  const runner = createFishAudioRunner({ env: { ...BASE_ENV } });

  await assert.rejects(
    () => runner(job(), { workspace, signal: new AbortController().signal }),
    /COMFYUI_BASE_URL/
  );
});

test("supports a custom workflow JSON override", async (t) => {
  const { env, state } = await startComfy(t, freshState());
  const workflowDir = await mkdtemp(path.join(tmpdir(), "hf-fish-wf-"));
  t.after(() => rm(workflowDir, { recursive: true, force: true }));
  const workflowPath = path.join(workflowDir, "workflow.json");
  await writeFile(
    workflowPath,
    JSON.stringify({
      "10": { class_type: "LoadAudio", inputs: { audio: "preset.wav" } },
      "11": {
        class_type: "FishS2TTS",
        inputs: {
          text: "",
          language: "en",
          reference_text: "",
          reference_audio: ["10", 0],
          model_path: "builtin-model",
          keep_model_loaded: false,
        },
      },
      "12": { class_type: "PreviewAudio", inputs: { audio: ["11", 0] } },
    })
  );
  const { workspace, narrationDir } = await makeInput(t);
  const runner = createFishAudioRunner({ env: {
    ...env,
    FISH_AUDIO_WORKFLOW_JSON: workflowPath,
    FISH_AUDIO_MODEL_PATH: "s2-turbo",
  } });

  const result = await runner(job(), { workspace, signal: new AbortController().signal });

  assert.deepEqual(result.artifacts, ["assets/narration/script.job-test.flac"]);
  const prompt = state.prompts[0].prompt;
  assert.equal(prompt["10"].inputs.audio, "renamed.m4a");
  assert.equal(prompt["11"].inputs.text, "Hello from a project asset.");
  assert.equal(prompt["11"].inputs.language, "de");
  assert.equal(prompt["11"].inputs.reference_text, "Transcript of the reference recording.");
  assert.equal(prompt["11"].inputs.model_path, "s2-turbo");
  assert.equal(prompt["11"].inputs.keep_model_loaded, false);
  assert.deepEqual(prompt["12"].inputs.audio, ["11", 0]);
  assert.deepEqual((await readdir(narrationDir)).sort(), ["script.job-test.flac", "script.txt"]);
});

async function makeVoiceStore(t, voices = [{ name: "pantek", refText: "Transcript stored in the registry.", language: "de" }]) {
  const voicesDir = await mkdtemp(path.join(tmpdir(), "hf-fish-store-"));
  const samplesDir = path.join(voicesDir, "samples");
  await mkdir(samplesDir, { recursive: true });
  const registry = [];
  for (const voice of voices) {
    const sampleFile = `${voice.name}${voice.ext || ".m4a"}`;
    const bytes = Buffer.from(voice.sampleBytes ?? "STORE-AUDIO-BYTES", "utf8");
    await writeFile(path.join(samplesDir, sampleFile), bytes);
    registry.push({
      name: voice.name,
      consent: "test-only consent",
      refText: voice.refText ?? null,
      language: voice.language ?? null,
      speakerDescription: null,
      sampleFile,
      sampleMime: "audio/mp4",
      sampleSize: bytes.length,
      createdAt: new Date().toISOString(),
    });
  }
  await writeFile(path.join(voicesDir, "registry.json"), JSON.stringify(registry, null, 2));
  t.after(() => rm(voicesDir, { recursive: true, force: true }));
  return voicesDir;
}

test("voice mode: resolves the stored sample + transcript + language from the global voice store", async (t) => {
  const { env, state } = await startComfy(t, freshState());
  const { workspace, narrationDir } = await makeInput(t);
  const voicesDir = await makeVoiceStore(t);
  const runner = createFishAudioRunner({ env, voicesDir });

  const result = await runner(
    job("job-voice", { voice: "pantek", reference_filename: undefined, reference_text: undefined, language: undefined }),
    { workspace, signal: new AbortController().signal }
  );

  assert.deepEqual(result.artifacts, ["assets/narration/script.job-voice.flac"]);
  assert.ok(state.uploads[0].includes("STORE-AUDIO-BYTES"));
  assert.ok(state.uploads[0].includes('filename="pantek.m4a"'));
  assert.ok(!state.uploads[0].includes("VOICEREF-AUDIO-BYTES"));
  const workflow = state.prompts[0].prompt;
  assert.equal(workflow["2"].inputs.audio, "renamed.m4a");
  assert.equal(workflow["1"].inputs.reference_text, "Transcript stored in the registry.");
  assert.equal(workflow["1"].inputs.language, "de"); // language comes from the stored entry
  assert.equal(workflow["1"].inputs.text, "Hello from a project asset.");
  assert.deepEqual(await readFile(path.join(narrationDir, "script.job-voice.flac")), makeFlac());
});

test("voice mode: per-call language wins over the stored one", async (t) => {
  const { env, state } = await startComfy(t, freshState());
  const { workspace } = await makeInput(t);
  const voicesDir = await makeVoiceStore(t);
  const runner = createFishAudioRunner({ env, voicesDir });

  await runner(
    job("job-voice-en", { voice: "pantek", reference_filename: undefined, reference_text: undefined, language: "en" }),
    { workspace, signal: new AbortController().signal }
  );
  assert.equal(state.prompts[0].prompt["1"].inputs.language, "en");
});

test("voice mode: falls back to FISH_AUDIO_LANGUAGE when the entry has none", async (t) => {
  const { env, state } = await startComfy(t, freshState());
  const { workspace } = await makeInput(t);
  const voicesDir = await makeVoiceStore(t, [{ name: "nolang", refText: "Only words." }]);
  const runner = createFishAudioRunner({ env, voicesDir });

  await runner(
    job("job-voice-def", { voice: "nolang", reference_filename: undefined, reference_text: undefined, language: undefined }),
    { workspace, signal: new AbortController().signal }
  );
  assert.equal(state.prompts[0].prompt["1"].inputs.language, "de");
});

test("voice wins over a raw reference pair", async (t) => {
  const { env, state } = await startComfy(t, freshState());
  const { workspace } = await makeInput(t);
  const voicesDir = await makeVoiceStore(t, [{ name: "pantek", refText: "Store transcript.", language: "de" }]);
  const runner = createFishAudioRunner({ env, voicesDir });

  await runner(
    job("job-voice-wins", { voice: "pantek", reference_text: "Raw transcript must be ignored." }),
    { workspace, signal: new AbortController().signal }
  );
  assert.ok(state.uploads[0].includes("STORE-AUDIO-BYTES"));
  assert.ok(!state.uploads[0].includes("VOICEREF-AUDIO-BYTES"));
  assert.equal(state.prompts[0].prompt["1"].inputs.reference_text, "Store transcript.");
});

test("voice mode: unknown, legacy and built-in voices fail cleanly before contacting ComfyUI", async (t) => {
  const { env, state } = await startComfy(t, freshState());
  const { workspace } = await makeInput(t);
  const legacyStore = await makeVoiceStore(t, [{ name: "legacy", refText: null, language: "de" }]);
  const runner = createFishAudioRunner({ env, voicesDir: await makeVoiceStore(t) });
  const legacyRunner = createFishAudioRunner({ env, voicesDir: legacyStore });
  const signal = new AbortController().signal;

  await assert.rejects(
    () => runner(job("v1", { voice: "ghost", reference_filename: undefined, reference_text: undefined }), { workspace, signal }),
    /Unknown stored voice "ghost"/
  );
  await assert.rejects(
    () => legacyRunner(job("v2", { voice: "legacy", reference_filename: undefined, reference_text: undefined }), { workspace, signal }),
    /no reference transcript/
  );
  await assert.rejects(
    () => runner(job("v3", { voice: "bad name!", reference_filename: undefined, reference_text: undefined }), { workspace, signal }),
    /Voice name/
  );
  await assert.rejects(
    () => runner(job("v4", { voice: "default", reference_filename: undefined, reference_text: undefined }), { workspace, signal }),
    /built-in voice/
  );
  assert.equal(state.requests.length, 0);
});

test("voice mode: enforces the store sample byte cap and store-absent runners reject voice mode", async (t) => {
  const tight = await startComfy(t, freshState());
  const { workspace } = await makeInput(t);
  const voicesDir = await makeVoiceStore(t);
  const runner = createFishAudioRunner({
    env: { ...tight.env, FISH_AUDIO_MAX_AUDIO_BYTES: "10" },
    voicesDir,
  });
  await assert.rejects(
    () => runner(job("cap", { voice: "pantek", reference_filename: undefined, reference_text: undefined }), { workspace, signal: new AbortController().signal }),
    /Voice sample "pantek" exceeds/
  );
  assert.equal(tight.state.requests.length, 0);

  const noStore = await startComfy(t, freshState());
  const noStoreRunner = createFishAudioRunner({ env: noStore.env });
  await assert.rejects(
    () => noStoreRunner(job("ns", { voice: "pantek", reference_filename: undefined, reference_text: undefined }), { workspace, signal: new AbortController().signal }),
    /voice store|No voice store/
  );
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
