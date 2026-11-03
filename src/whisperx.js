import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanupPublishedFile,
  cleanupTempFile,
  createPrivateTempFile,
  publishNoReplace,
  resolveAssetInput,
  resolveAssetOutput,
} from "./asset-ops.js";

const DEFAULT_MAX_AUDIO_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_JSON_BYTES = 20 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set([
  ".aac", ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav",
]);

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getWhisperXConfig(env = process.env) {
  return {
    executable: String(env.WHISPERX_EXECUTABLE || "whisperx").trim(),
    model: String(env.WHISPERX_MODEL || "base").trim(),
    modelCacheDir: String(env.WHISPERX_MODEL_CACHE_DIR || "/data/whisperx-cache").trim(),
    maxAudioBytes: positiveInt(env.WHISPERX_MAX_AUDIO_BYTES, DEFAULT_MAX_AUDIO_BYTES),
    maxJsonBytes: positiveInt(env.WHISPERX_MAX_JSON_BYTES, DEFAULT_MAX_JSON_BYTES),
  };
}

function validateLanguage(language) {
  if (language === undefined || language === null || language === "") return null;
  if (typeof language !== "string" || !/^[a-z]{2,3}$/i.test(language)) {
    throw new Error("WhisperX language must be a two- or three-letter language code");
  }
  return language.toLowerCase();
}

function validateSegments(transcript) {
  if (!transcript || typeof transcript !== "object" || !Array.isArray(transcript.segments)) {
    throw new Error("WhisperX output JSON must contain a segments array");
  }
  let wordAlignmentAvailable = transcript.segments.length > 0;
  for (const segment of transcript.segments) {
    if (!segment || typeof segment !== "object" || !Number.isFinite(segment.start) || segment.start < 0 ||
        !Number.isFinite(segment.end) || segment.end < segment.start || typeof segment.text !== "string") {
      throw new Error("WhisperX output contains an invalid timed segment");
    }
    const words = segment.words;
    if (words == null || (Array.isArray(words) && words.length === 0)) {
      wordAlignmentAvailable = false;
      continue;
    }
    if (!Array.isArray(words)) throw new Error("WhisperX output contains invalid word entries");
    for (const word of words) {
      if (!word || typeof word.word !== "string") throw new Error("WhisperX output contains invalid word entries");
      const hasStart = word.start != null;
      const hasEnd = word.end != null;
      if ((hasStart && (!Number.isFinite(word.start) || word.start < 0)) ||
          (hasEnd && (!Number.isFinite(word.end) || word.end < 0)) ||
          (hasStart && hasEnd && word.end < word.start)) {
        throw new Error("WhisperX output contains invalid word timestamps");
      }
      if (!hasStart || !hasEnd) wordAlignmentAvailable = false;
    }
  }
  if (!wordAlignmentAvailable && transcript.segments.length > 0) {
    const language = typeof transcript.language === "string" ? transcript.language : "unknown";
    return [`Word-level alignment was unavailable or incomplete for language ${language}; segment timestamps are available.`];
  }
  return [];
}

async function readJsonOutput(outputPath, outputDir, maxBytes) {
  const outputDirReal = await fs.realpath(outputDir);
  const stat = await fs.lstat(outputPath).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("WhisperX did not produce a regular JSON output file");
  }
  if (stat.size > maxBytes) throw new Error(`WhisperX JSON output exceeds the ${maxBytes}-byte limit`);
  const outputReal = await fs.realpath(outputPath);
  if (outputReal !== outputDirReal && !outputReal.startsWith(outputDirReal + path.sep)) {
    throw new Error("WhisperX output escaped its temporary directory");
  }

  const handle = await fs.open(outputReal, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const chunks = [];
    let size = 0;
    while (size <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(8192, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error(`WhisperX JSON output exceeds the ${maxBytes}-byte limit`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) {
        throw new Error("WhisperX produced malformed UTF-8 JSON");
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function runWhisperX(executable, args, options, context) {
  let child;
  try {
    child = context.spawn(executable, args, options);
  } catch (error) {
    throw new Error(`Unable to start WhisperX; check WHISPERX_EXECUTABLE: ${error.message}`);
  }
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error("WhisperX executable not found; configure WHISPERX_EXECUTABLE"));
      } else {
        reject(new Error(`Unable to start WhisperX: ${error.message}`));
      }
    });
    child.once("close", (code, signal) => {
      if (context.signal.aborted) return reject(context.signal.reason || new Error("Job canceled"));
      if (signal) return reject(new Error(`WhisperX was terminated by signal ${signal}`));
      if (code !== 0) {
        return reject(new Error(`WhisperX exited with code ${code}; check job logs for model or download errors`));
      }
      resolve();
    });
  });
}

export function createWhisperXRunner({ env = process.env } = {}) {
  return async (job, context) => {
    const config = getWhisperXConfig(env);
    if (!config.executable) throw new Error("WhisperX is not configured: set WHISPERX_EXECUTABLE");
    if (!config.model) throw new Error("WhisperX is not configured: set WHISPERX_MODEL");
    if (!config.modelCacheDir) throw new Error("WhisperX is not configured: set WHISPERX_MODEL_CACHE_DIR");
    if (context.signal.aborted) throw context.signal.reason || new Error("Job canceled");

    const filename = job.params?.filename;
    const language = validateLanguage(job.params?.language);
    const projectDir = path.resolve(context.workspace, job.project || ".");
    const input = await resolveAssetInput({ workspace: context.workspace, projectDir, filename });
    if (!AUDIO_EXTENSIONS.has(path.extname(input.path).toLowerCase())) {
      throw new Error("WhisperX input must be a supported audio asset");
    }
    if (input.stat.size === 0) throw new Error("WhisperX input audio is empty");
    if (input.stat.size > config.maxAudioBytes) {
      throw new Error(`WhisperX audio exceeds the ${config.maxAudioBytes}-byte limit`);
    }
    const currentStat = await fs.stat(input.path);
    if (!currentStat.isFile() || currentStat.size === 0 || currentStat.size > config.maxAudioBytes) {
      throw new Error("WhisperX input changed or exceeds the configured audio size limit");
    }
    if (context.signal.aborted) throw context.signal.reason || new Error("Job canceled");

    const output = await resolveAssetOutput({
      workspace: context.workspace,
      projectDir,
      filename,
      jobId: job.id,
      extension: ".json",
    });
    if (output.inputPath !== input.path) throw new Error("WhisperX input changed while the job was queued");

    const modelCacheDir = path.resolve(config.modelCacheDir);
    await fs.mkdir(modelCacheDir, { recursive: true });
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), `hf-whisperx-${job.id}-`));
    let temporary;
    let identity;
    let published = false;
    let result;
    try {
      await fs.chmod(outputDir, 0o700);
      const args = [
        input.path,
        "--device", "cpu",
        "--compute_type", "int8",
        "--output_format", "json",
        "--model", config.model,
        "--model_dir", modelCacheDir,
        "--output_dir", outputDir,
      ];
      if (language) args.push("--language", language);
      await runWhisperX(config.executable, args, {
        cwd: outputDir,
        env: {
          HF_HOME: modelCacheDir,
          HF_HUB_CACHE: path.join(modelCacheDir, "hub"),
          TORCH_HOME: modelCacheDir,
          XDG_CACHE_HOME: modelCacheDir,
        },
      }, context);
      if (context.signal.aborted) throw context.signal.reason || new Error("Job canceled");

      const jsonPath = path.join(outputDir, `${path.parse(input.path).name}.json`);
      const transcript = await readJsonOutput(jsonPath, outputDir, config.maxJsonBytes);
      const warnings = validateSegments(transcript);
      const serialized = Buffer.from(`${JSON.stringify(transcript, null, 2)}\n`, "utf8");
      if (serialized.length > config.maxJsonBytes) {
        throw new Error(`WhisperX JSON output exceeds the ${config.maxJsonBytes}-byte limit`);
      }
      const revalidated = await resolveAssetOutput({
        workspace: context.workspace,
        projectDir,
        filename,
        jobId: job.id,
        extension: ".json",
      });
      if (revalidated.path !== output.path || revalidated.inputPath !== input.path) {
        throw new Error("WhisperX asset paths changed while the job was running");
      }
      if (context.signal.aborted) throw context.signal.reason || new Error("Job canceled");

      temporary = await createPrivateTempFile(output.parent, job.id);
      await temporary.handle.writeFile(serialized);
      await temporary.handle.sync();
      identity = await temporary.handle.stat();
      await temporary.handle.close();
      if (context.signal.aborted) throw context.signal.reason || new Error("Job canceled");
      await publishNoReplace(temporary.path, output.path, output.parent, identity);
      published = true;
      result = {
        artifacts: [output.artifactPath],
        warnings,
        cleanup: () => cleanupPublishedFile(output.path, output.parent, identity),
      };
    } finally {
      let cleanupError;
      if (temporary) {
        await temporary.handle.close().catch(() => {});
        try {
          await cleanupTempFile(temporary.path);
        } catch (error) {
          cleanupError = error;
        }
      }
      try {
        await fs.rm(outputDir, { recursive: true, force: true });
      } catch (error) {
        cleanupError ||= error;
      }
      if (cleanupError) {
        if (published) await cleanupPublishedFile(output.path, output.parent, identity).catch(() => {});
        throw cleanupError;
      }
    }
    if (context.signal.aborted) {
      await cleanupPublishedFile(output.path, output.parent, identity);
      throw context.signal.reason || new Error("Job canceled");
    }
    return result;
  };
}