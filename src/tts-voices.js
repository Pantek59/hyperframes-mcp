/**
 * tts-voices.js — voice cloning against the upstream TTS-API (sglang-omni).
 *
 * POST /v1/audio/voices  (multipart/form-data)
 *   audio_sample         reference audio file (mp3/wav/…)
 *   name                 registry name the speech endpoint accepts as `voice`
 *   consent              required by the upstream API — cloning is only
 *                        allowed for voices the caller is authorized to use
 *   ref_text             optional transcript of the sample
 *   speaker_description  optional free-text description
 *
 * GET /v1/audio/voices → { voices: [...], uploaded_voices: [...] }
 *
 * Safety mirrors tts-api.js: bounded reads, no leaking of remote error
 * bodies, no output artifacts (the registry lives on the TTS server).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { getTtsApiConfig } from "./tts-api.js";
import { resolveAssetInput } from "./asset-ops.js";

const DEFAULT_MAX_SAMPLE_BYTES = 25 * 1024 * 1024; // 25 MB
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024; // 64 KB

const SAMPLE_EXTS = new Set([
  "mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "aiff", "aif", "webm", "mp4",
]);

const SAMPLE_MIMES = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/opus",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  webm: "audio/webm",
  mp4: "audio/mp4",
};

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Validate the base URL exactly like the speech endpoint does, then target /v1/audio/voices. */
function voicesEndpoint(baseUrl) {
  if (!baseUrl) throw new Error("TTS API is not configured: set TTS_API_BASE_URL");
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("TTS_API_BASE_URL must be a valid HTTP(S) base URL");
  }
  if (!new Set(["http:", "https:"]).has(base.protocol) || base.username || base.password ||
      base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) {
    throw new Error("TTS_API_BASE_URL must be an HTTP(S) origin without credentials or a path");
  }
  return new URL("/v1/audio/voices", base);
}

async function readBoundedFile(inputPath, maxBytes) {
  const handle = await fs.open(inputPath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Voice sample must be a regular file");
    if (stat.size > maxBytes) throw new Error(`Voice sample exceeds the ${maxBytes}-byte limit`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readBoundedResponse(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("TTS voices API response exceeds the limit");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function requireConfig(config) {
  if (!config.baseUrl) throw new Error("TTS API is not configured: set TTS_API_BASE_URL");
}

export function createTtsUploadVoiceRunner({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = getTtsApiConfig(env);
  const maxSampleBytes = positiveInt(env.TTS_API_MAX_SAMPLE_BYTES, DEFAULT_MAX_SAMPLE_BYTES);

  return async (job, { workspace, signal }) => {
    const endpoint = voicesEndpoint(config.baseUrl);
    if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch");

    const params = job.params ?? {};
    const name = String(params.name ?? "").trim();
    if (!NAME_RE.test(name)) {
      throw new Error("Voice name must match [A-Za-z0-9._-] and be 1–64 characters");
    }
    const consent = String(params.consent ?? "").trim();
    if (!consent) throw new Error("A consent statement is required to register a cloned voice");
    if (consent.length > 1000) throw new Error("Consent statement exceeds 1000 characters");
    const refText = String(params.refText ?? "").trim().slice(0, 10_000);
    const speakerDescription = String(params.speakerDescription ?? "").trim().slice(0, 2000);

    const projectDir = path.resolve(workspace, job.project || ".");
    const input = await resolveAssetInput({ workspace, projectDir, filename: params.filename });
    const ext = path.extname(input.path).toLowerCase().slice(1);
    if (!SAMPLE_EXTS.has(ext)) {
      throw new Error(`Voice sample must be an audio file (${[...SAMPLE_EXTS].join(", ")})`);
    }
    const audio = await readBoundedFile(input.path, maxSampleBytes);
    if (signal.aborted) throw signal.reason || new Error("Job canceled");

    const form = new FormData();
    form.append("audio_sample", new Blob([audio], { type: SAMPLE_MIMES[ext] }), path.basename(input.path));
    form.append("name", name);
    form.append("consent", consent);
    if (refText) form.append("ref_text", refText);
    if (speakerDescription) form.append("speaker_description", speakerDescription);

    const headers = { accept: "application/json" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: form,
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`TTS voices API returned HTTP ${response.status}`);
    }
    const mediaType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!mediaType.startsWith("application/json")) {
      throw new Error("TTS voices API returned an unexpected response type");
    }
    await readBoundedResponse(response, DEFAULT_MAX_RESPONSE_BYTES);
    // The registry result is confirmed server-side via list_voices; the job
    // carries no project artifacts.
    return { artifacts: [] };
  };
}

/** GET /v1/audio/voices — list available voices (default + registered clones). */
export async function listVoices({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = getTtsApiConfig(env);
  const endpoint = voicesEndpoint(config.baseUrl);
  if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch");
  const headers = { accept: "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const response = await fetchImpl(endpoint, { headers, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`TTS voices API returned HTTP ${response.status}`);
  }
  const mediaType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!mediaType.startsWith("application/json")) {
    throw new Error("TTS voices API returned an unexpected response type");
  }
  const body = await readBoundedResponse(response, DEFAULT_MAX_RESPONSE_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("TTS voices API returned malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TTS voices API response is not a voice registry object");
  }
  return parsed;
}
