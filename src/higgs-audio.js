import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import {
  cleanupPublishedFile,
  cleanupTempFile,
  createPrivateTempFile,
  publishNoReplace,
  resolveAssetInput,
  resolveAssetOutput,
} from "./asset-ops.js";

const DEFAULT_MAX_TEXT_BYTES = 64 * 1024;
const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getHiggsAudioConfig(env = process.env) {
  return {
    baseUrl: String(env.HIGGS_AUDIO_BASE_URL || "").trim(),
    model: String(env.HIGGS_AUDIO_MODEL || "").trim(),
    voice: String(env.HIGGS_AUDIO_VOICE || "").trim(),
    apiKey: String(env.HIGGS_AUDIO_API_KEY || "").trim(),
    maxTextBytes: positiveInt(env.HIGGS_AUDIO_MAX_TEXT_BYTES, DEFAULT_MAX_TEXT_BYTES),
    maxAudioBytes: positiveInt(env.HIGGS_AUDIO_MAX_AUDIO_BYTES, DEFAULT_MAX_AUDIO_BYTES),
  };
}

function speechEndpoint(baseUrl) {
  if (!baseUrl) throw new Error("Higgs Audio is not configured: set HIGGS_AUDIO_BASE_URL");
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("HIGGS_AUDIO_BASE_URL must be a valid HTTP(S) base URL");
  }
  if (!new Set(["http:", "https:"]).has(base.protocol) || base.username || base.password ||
      base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) {
    throw new Error("HIGGS_AUDIO_BASE_URL must be an HTTP(S) origin without credentials or a path");
  }
  return new URL("/v1/audio/speech", base);
}

async function readText(inputPath, maxBytes) {
  const handle = await fs.open(inputPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("TTS input must be a regular file");
    if (stat.size > maxBytes) throw new Error(`TTS text exceeds the ${maxBytes}-byte limit`);
    const chunks = [];
    let size = 0;
    while (size <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(8192, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error(`TTS text exceeds the ${maxBytes}-byte limit`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
    } catch {
      throw new Error("TTS input must contain valid UTF-8 text");
    }
    if (!text.trim() || text.includes("\0")) throw new Error("TTS input must be non-empty UTF-8 text");
    return text;
  } finally {
    await handle.close();
  }
}

async function readBoundedResponse(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Higgs Audio response exceeds the ${maxBytes}-byte limit`);
  }
  if (!response.body) throw new Error("Higgs Audio returned an empty response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`Higgs Audio response exceeds the ${maxBytes}-byte limit`);
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
    throw new Error("Higgs Audio response must have an audio/wav content type");
  }
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" ||
      buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Higgs Audio returned an invalid WAV file");
  }
  const riffLength = buffer.readUInt32LE(4);
  if (riffLength < 36 || riffLength + 8 > buffer.length) {
    throw new Error("Higgs Audio returned a truncated or malformed WAV file");
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
    if (next > end) throw new Error("Higgs Audio returned a truncated or malformed WAV file");
    if (chunk === "fmt ") {
      if (size < 16 || buffer.readUInt16LE(start) === 0 || buffer.readUInt16LE(start + 2) === 0 ||
          buffer.readUInt32LE(start + 4) === 0 || buffer.readUInt16LE(start + 12) === 0) {
        throw new Error("Higgs Audio returned a malformed WAV format chunk");
      }
      hasFormat = true;
    } else if (chunk === "data" && size > 0) {
      hasAudio = true;
    }
    offset = next;
  }
  if (offset !== end || !hasFormat || !hasAudio) {
    throw new Error("Higgs Audio returned a malformed WAV file");
  }
  return buffer;
}

export function createHiggsAudioRunner({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async (job, { workspace, signal }) => {
    const config = getHiggsAudioConfig(env);
    const endpoint = speechEndpoint(config.baseUrl);
    if (!config.model) throw new Error("Higgs Audio is not configured: set HIGGS_AUDIO_MODEL");
    if (!config.voice) throw new Error("Higgs Audio is not configured: set HIGGS_AUDIO_VOICE");
    if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch");

    const filename = job.params?.filename;
    const projectDir = path.resolve(workspace, job.project || ".");
    const input = await resolveAssetInput({ workspace, projectDir, filename });
    const text = await readText(input.path, config.maxTextBytes);
    if (signal.aborted) throw signal.reason || new Error("Job canceled");

    const headers = { "content-type": "application/json", accept: "audio/wav" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        input: text,
        voice: config.voice,
        response_format: "wav",
      }),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Higgs Audio API returned HTTP ${response.status}`);
    }
    const audio = validateWav(
      await readBoundedResponse(response, config.maxAudioBytes),
      response.headers.get("content-type")
    );
    if (signal.aborted) throw signal.reason || new Error("Job canceled");

    const output = await resolveAssetOutput({
      workspace,
      projectDir,
      filename,
      jobId: job.id,
      extension: ".wav",
    });
    if (output.inputPath !== input.path) throw new Error("TTS input changed while the job was running");
    let temporary;
    let identity;
    let published = false;
    try {
      temporary = await createPrivateTempFile(output.parent, job.id);
      await temporary.handle.writeFile(audio);
      await temporary.handle.sync();
      identity = await temporary.handle.stat();
      await temporary.handle.close();
      if (signal.aborted) throw signal.reason || new Error("Job canceled");
      const revalidated = await resolveAssetOutput({
        workspace,
        projectDir,
        filename,
        jobId: job.id,
        extension: ".wav",
      });
      if (revalidated.path !== output.path || revalidated.inputPath !== input.path) {
        throw new Error("TTS asset paths changed while the job was running");
      }
      if (signal.aborted) throw signal.reason || new Error("Job canceled");
      await publishNoReplace(temporary.path, output.path, output.parent, identity);
      published = true;
    } finally {
      if (temporary) {
        await temporary.handle.close().catch(() => {});
        try {
          await cleanupTempFile(temporary.path);
        } catch (error) {
          if (published) await cleanupPublishedFile(output.path, output.parent, identity).catch(() => {});
          throw error;
        }
      }
    }
    if (signal.aborted) {
      await cleanupPublishedFile(output.path, output.parent, identity);
      throw signal.reason || new Error("Job canceled");
    }
    return {
      artifacts: [output.artifactPath],
      cleanup: () => cleanupPublishedFile(output.path, output.parent, identity),
    };
  };
}