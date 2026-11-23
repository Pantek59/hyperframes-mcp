import path from "node:path";
import { upstreamFetch, validateHttpOrigin } from "./fetch-utils.js";
import {
  publishAssetOutput,
  readText,
  resolveAssetInput,
} from "./asset-ops.js";

const DEFAULT_MAX_TEXT_BYTES = 64 * 1024;
const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getTtsApiConfig(env = process.env) {
  return {
    baseUrl: String(env.TTS_API_BASE_URL || env.TTS_BASE_URL || "").trim(),
    model: String(env.TTS_API_MODEL || env.TTS_MODEL || "").trim(),
    voice: String(env.TTS_API_VOICE || env.TTS_VOICE || "").trim(),
    apiKey: String(env.TTS_API_API_KEY || env.TTS_API_KEY || "").trim(),
    maxTextBytes: positiveInt(env.TTS_API_MAX_TEXT_BYTES, DEFAULT_MAX_TEXT_BYTES),
    maxAudioBytes: positiveInt(env.TTS_API_MAX_AUDIO_BYTES, DEFAULT_MAX_AUDIO_BYTES),
  };
}

function speechEndpoint(baseUrl) {
  const base = validateHttpOrigin(baseUrl, "TTS API", "TTS_API_BASE_URL");
  return new URL("/v1/audio/speech", base);
}

async function readBoundedResponse(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`TTS API response exceeds the ${maxBytes}-byte limit`);
  }
  if (!response.body) throw new Error("TTS API returned an empty response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`TTS API response exceeds the ${maxBytes}-byte limit`);
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

function validateWav(buffer, contentType) {
  const mediaType = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (!new Set(["audio/wav", "audio/x-wav", "audio/wave"]).has(mediaType)) {
    throw new Error("TTS API response must have an audio/wav content type");
  }
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" ||
      buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("TTS API returned an invalid WAV file");
  }
  const riffLength = buffer.readUInt32LE(4);
  if (riffLength < 36 || riffLength + 8 > buffer.length) {
    throw new Error("TTS API returned a truncated or malformed WAV file");
  }
  const end = riffLength + 8;
  let offset = 12;
  let hasFormat = false;
  let hasAudio = false;
  while (offset + 8 <= end) {
    const chunk = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const next = start + size + (size % 2);
    if (next > end) throw new Error("TTS API returned a truncated or malformed WAV file");
    if (chunk === "fmt ") {
      if (size < 16 || buffer.readUInt16LE(start) === 0 || buffer.readUInt16LE(start + 2) === 0 ||
          buffer.readUInt32LE(start + 4) === 0 || buffer.readUInt16LE(start + 12) === 0) {
        throw new Error("TTS API returned a malformed WAV format chunk");
      }
      hasFormat = true;
    } else if (chunk === "data" && size > 0) {
      hasAudio = true;
    }
    offset = next;
  }
  if (offset !== end || !hasFormat || !hasAudio) {
    throw new Error("TTS API returned a malformed WAV file");
  }
  return buffer;
}

export function createTtsApiRunner({ env = process.env, fetchImpl = globalThis.fetch, reRegister = null } = {}) {
  return async (job, { workspace, signal }) => {
    const config = getTtsApiConfig(env);
    const endpoint = speechEndpoint(config.baseUrl);
    if (!config.model) throw new Error("TTS API is not configured: set TTS_API_MODEL");
    // Per-call voice override (e.g. a cloned voice registered via tts_upload_voice)
    const voice = String(job.params?.voice ?? config.voice ?? "").trim();
    if (!voice) throw new Error("TTS API is not configured: set TTS_API_VOICE");
    if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch");

    const filename = job.params?.filename;
    const projectDir = path.resolve(workspace, job.project || ".");
    const input = await resolveAssetInput({ workspace, projectDir, filename });
    const text = await readText(input.path, config.maxTextBytes);
    if (signal.aborted) throw signal.reason || new Error("Job canceled");

    const headers = { "content-type": "application/json", accept: "audio/wav" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const speak = () =>
      upstreamFetch(fetchImpl, endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          input: text,
          voice: voice,
          response_format: "wav",
        }),
        signal,
        redirect: "error",
      }, "TTS API /v1/audio/speech");
    let response = await speak();
    const warnings = [];
    if (!response.ok && reRegister && (response.status === 400 || response.status === 404)) {
      // A stored clone whose upstream encoding was evicted (or lost via an
      // upstream restart) — re-registering from the voice store and retrying
      // once. Any failure here falls back to the original HTTP error below.
      await response.body?.cancel().catch(() => {});
      try {
        if (await reRegister(voice, signal)) {
          warnings.push(`re-registered cloned voice "${voice}" from the voice store after upstream loss`);
          response = await speak();
        }
      } catch {
        /* keep the first response and surface its status */
      }
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`TTS API (${endpoint.origin}) returned HTTP ${response.status}`);
    }
    const audio = validateWav(
      await readBoundedResponse(response, config.maxAudioBytes),
      response.headers.get("content-type")
    );
    if (signal.aborted) throw signal.reason || new Error("Job canceled");

    const output = await publishAssetOutput({
      workspace,
      projectDir,
      filename,
      jobId: job.id,
      extension: ".wav",
      bytes: audio,
      inputPath: input.path,
      signal,
    });
    return {
      artifacts: [output.artifactPath],
      warnings,
      cleanup: output.cleanup,
    };
  };
}
