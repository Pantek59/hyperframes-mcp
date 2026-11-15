/**
 * tts-voices.js — voice cloning against the upstream TTS-API (sglang-omni)
 * plus a server-owned, project-independent voice store.
 *
 * Upstream API:
 *   POST   /v1/audio/voices       (multipart: audio_sample, name, consent, ref_text, speaker_description)
 *   GET    /v1/audio/voices       → { voices: [...], uploaded_voices: [...], cache_stats: {...} }
 *   DELETE /v1/audio/voices/{name}
 *
 * The upstream keeps cloned voices in an in-memory cache (upload response and
 * GET expose eviction counters, bounded max_bytes) — clones can silently
 * disappear. The local store (HF_VOICES_DIR, default /data/voices) owns the
 * canonical sample so voices survive evictions and sglang restarts:
 *
 *   <HF_VOICES_DIR>/
 *     registry.json               # [{ name, consent, refText, language, speakerDescription, sampleFile, sampleMime, sampleSize, createdAt }]
 *     samples/<name>.<ext>        # canonical sample copy
 *
 * The registry is the single voice registry for BOTH TTS backends: the
 * TTS-API (Higgs, voices referenced by name) and the ComfyUI Fish Audio S2
 * runner (voices cloned per job from the stored sample + refText + language).
 *
 * The store lives OUTSIDE HF_WORKSPACE: the token-free /files/ route is rooted
 * at the workspace, so voice samples are never publicly reachable.
 *
 * Safety mirrors tts-api.js: bounded reads, no leaking of remote error
 * bodies, single-decode path handling.
 */
import { randomUUID } from "node:crypto";
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

/** Validate the base URL exactly like the speech endpoint does. */
function ttsApiUrl(baseUrl, route) {
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
  return new URL(route, base);
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

function authHeaders(config, accept) {
  const headers = { accept };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}

async function ensureJson(response, maxBytes) {
  const mediaType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!mediaType.startsWith("application/json")) {
    throw new Error("TTS voices API returned an unexpected response type");
  }
  const body = await readBoundedResponse(response, maxBytes);
  return JSON.parse(body.toString("utf8"));
}

// ── Voice store (project-independent) ────────────────────────────────────────

function storeRoots(voicesDir) {
  if (typeof voicesDir !== "string" || !voicesDir.trim()) {
    throw new Error("No voice store configured (HF_VOICES_DIR)");
  }
  const root = path.resolve(voicesDir);
  return { root, samplesDir: path.join(root, "samples"), registryPath: path.join(root, "registry.json") };
}

export async function loadRegistry(voicesDir) {
  const { registryPath } = storeRoots(voicesDir);
  let content;
  try {
    content = await fs.readFile(registryPath, "utf8");
  } catch {
    return [];
  }
  let entries;
  try {
    entries = JSON.parse(content);
  } catch {
    throw new Error(`Voice store registry is corrupt: ${registryPath}`);
  }
  if (!Array.isArray(entries)) throw new Error(`Voice store registry is corrupt: ${registryPath}`);
  return entries;
}

export const listFromStore = loadRegistry;

async function saveRegistry(voicesDir, entries) {
  const { root, registryPath } = storeRoots(voicesDir);
  await fs.mkdir(root, { recursive: true });
  const tmp = `${registryPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2));
  await fs.rename(tmp, registryPath);
}

/**
 * Copy a sample into the store and create/replace its registry entry.
 * The caller must have validated `entry`; returns the stored entry.
 */
export async function storeSample(voicesDir, entry, samplePath, sampleBytes) {
  const { root, samplesDir } = storeRoots(voicesDir);
  await fs.mkdir(samplesDir, { recursive: true });
  const sampleFile = `${entry.name}${path.extname(samplePath) || ""}`;
  const target = path.join(samplesDir, sampleFile);
  if (!path.dirname(target).startsWith(samplesDir)) throw new Error("Voice sample name escapes the store");
  await fs.copyFile(samplePath, target);
  const stored = { ...entry, sampleFile, sampleMime: entry.sampleMime || SAMPLE_MIMES[path.extname(samplePath).slice(1)] || "application/octet-stream", sampleSize: sampleBytes };
  const registry = (await loadRegistry(voicesDir)).filter((e) => e.name !== entry.name);
  registry.push(stored);
  await saveRegistry(voicesDir, registry);
  return { ...stored, samplePath: target };
}

export async function removeFromStore(voicesDir, name) {
  const registry = await loadRegistry(voicesDir);
  const entry = registry.find((e) => e.name === name);
  if (!entry) return null;
  const { samplesDir } = storeRoots(voicesDir);
  if (entry.sampleFile) {
    await fs.unlink(path.join(samplesDir, entry.sampleFile)).catch(() => {});
  }
  await saveRegistry(voicesDir, registry.filter((e) => e.name !== name));
  return entry;
}

export function validateName(name) {
  const clean = String(name ?? "").trim();
  if (!NAME_RE.test(clean)) {
    throw new Error("Voice name must match [A-Za-z0-9._-] and be 1–64 characters");
  }
  return clean;
}

/** Language code stored with a registry entry (used by the Fish S2 backend). */
export function normalizeLanguage(language) {
  const clean = String(language ?? "").trim();
  if (!clean) return "";
  if (!/^[A-Za-z]{2,3}$/.test(clean)) {
    throw new Error("Language must be a 2–3 letter ISO code (e.g. de, en, spa)");
  }
  return clean.toLowerCase();
}

/**
 * Resolve a stored voice for ANY backend: returns
 * { name, entry, samplePath, refText, language } or NULL when the name is not
 * stored (or its sample file went missing). `entry` carries consent and other
 * registration metadata; callers must handle a null refText (legacy entries
 * registered before transcripts became required are not Fish-ready).
 */
export async function getStoredVoice(voicesDir, name) {
  const clean = validateName(name);
  if (clean === "default") {
    throw new Error('"default" is the upstream built-in voice, not a stored clone — fish_audio_tts cannot use it');
  }
  if (!voicesDir) throw new Error("No voice store configured (HF_VOICES_DIR)");
  const entry = (await loadRegistry(voicesDir)).find((e) => e.name === clean);
  if (!entry) return null;
  const { samplesDir } = storeRoots(voicesDir);
  const samplePath = entry.sampleFile ? path.join(samplesDir, entry.sampleFile) : null;
  if (!samplePath) return null;
  const stat = await fs.stat(samplePath).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  return { name: clean, entry, samplePath, refText: String(entry.refText ?? ""), language: entry.language || null };
}

/** Upload a sample file upstream (the shared clone-registration step). */
async function uploadUpstream({ config, fetchImpl, samplePath, sampleBytes }, { name, consent, refText, speakerDescription }, signal) {
  const endpoint = ttsApiUrl(config.baseUrl, "/v1/audio/voices");
  const audio = await readBoundedFile(samplePath, sampleBytes ?? DEFAULT_MAX_SAMPLE_BYTES);
  const form = new FormData();
  form.append("audio_sample", new Blob([audio], { type: SAMPLE_MIMES[path.extname(samplePath).slice(1)] }), path.basename(samplePath));
  form.append("name", name);
  form.append("consent", consent);
  if (refText) form.append("ref_text", refText);
  if (speakerDescription) form.append("speaker_description", speakerDescription);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: authHeaders(config, "application/json"),
    body: form,
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`TTS voices API returned HTTP ${response.status}`);
  }
  await ensureJson(response, DEFAULT_MAX_RESPONSE_BYTES);
}

// ── Store-resident samples (inbox): register without any project ─────────────

/**
 * Resolve a sample that lives INSIDE the voice store (dropped by a user or an
 * agent directly into <HF_VOICES_DIR> — accepted in the root or in inbox/).
 * Managed paths (samples/, registry.json) are off limits. Returns
 * { path, ext } or NULL when `filename` does not exist in the store.
 */
export async function resolveStoreSample(voicesDir, filename) {
  const { root } = storeRoots(voicesDir);
  const relName = typeof filename === "string" ? filename.trim() : "";
  if (!relName || relName.includes("\0") || relName.includes("\\") ||
      path.isAbsolute(relName) || path.win32.isAbsolute(relName) ||
      relName.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  const candidates = [path.join(root, relName), path.join(root, "inbox", relName)];
  for (const candidate of candidates) {
    const real = await fs.realpath(candidate).catch(() => null);
    if (!real) continue;
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (rel === "registry.json" || rel === "samples" || rel.startsWith("samples" + path.sep)) continue;
    const stat = await fs.stat(real).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    const ext = path.extname(real).toLowerCase().slice(1);
    if (!SAMPLE_EXTS.has(ext)) continue;
    return { path: real, ext };
  }
  return null;
}

/**
 * Audio files dropped into the store (root or inbox/) that are not yet
 * registered — surfaced by list_voices so agents can see and register them.
 */
export async function listInbox(voicesDir) {
  if (!voicesDir) return [];
  const { root } = storeRoots(voicesDir);
  const out = [];
  for (const [dir, display] of [[root, ""], [path.join(root, "inbox"), "inbox/"]]) {
    let dirents = [];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const de of dirents) {
      if (!de.isFile() || de.name.startsWith(".")) continue;
      if (!SAMPLE_EXTS.has(path.extname(de.name).toLowerCase().slice(1))) continue;
      if (display === "" && de.name === "registry.json") continue;
      const st = await fs.stat(path.join(dir, de.name)).catch(() => null);
      if (!st) continue;
      out.push({ file: `${display}${de.name}`, size: st.size, modified: st.mtime.toISOString(), type: "audio" });
    }
  }
  const seen = new Set();
  return out.filter((f) => (seen.has(f.file) ? false : (seen.add(f.file), true)));
}


// ── Job runner: tts_upload_voice ─────────────────────────────────────────────

export function createTtsUploadVoiceRunner({ env = process.env, voicesDir, fetchImpl = globalThis.fetch } = {}) {
  const config = getTtsApiConfig(env);
  const maxSampleBytes = positiveInt(env.TTS_API_MAX_SAMPLE_BYTES, DEFAULT_MAX_SAMPLE_BYTES);
  if (!voicesDir) throw new Error("tts_upload_voice requires a voice store (HF_VOICES_DIR)");

  return async (job, { workspace, signal }) => {
    const params = job.params ?? {};
    const name = validateName(params.name);
    const consent = String(params.consent ?? "").trim();
    if (!consent) throw new Error("A consent statement is required to register a cloned voice");
    if (consent.length > 1000) throw new Error("Consent statement exceeds 1000 characters");
    // The transcript is NOT optional: Fish Audio S2 cloning (ComfyUI) needs the
    // exact transcript to clone from the same stored sample, so every registry
    // entry must carry one to keep both backends usable.
    const refText = String(params.refText ?? "").trim().slice(0, 10_000);
    if (!refText) {
      throw new Error("A reference transcript (ref_text) is required to register a voice — Fish Audio S2 cloning needs the exact transcript of the sample");
    }
    const language = normalizeLanguage(params.language);
    const speakerDescription = String(params.speakerDescription ?? "").trim().slice(0, 2000);

    // Sample source 1: a project's assets/ (as before).
    // Sample source 2: the voice store itself (root or inbox/) — no project needed.
    let samplePath = null;
    let ext = null;
    let fromStore = false;
    if (job.project) {
      try {
        const input = await resolveAssetInput({ workspace, projectDir: path.resolve(workspace, job.project), filename: params.filename });
        samplePath = input.path;
        ext = path.extname(input.path).toLowerCase().slice(1);
      } catch {
        samplePath = null; // fall through to the store lookup
      }
    }
    if (!samplePath) {
      const store = await resolveStoreSample(voicesDir, params.filename);
      if (store) {
        samplePath = store.path;
        ext = store.ext;
        fromStore = true;
      }
    }
    if (!samplePath) {
      throw new Error(
        `Voice sample not found: give a file in a project's assets/ (with project), or drop the audio into the voice store (${path.basename(voicesDir)}/ root or inbox/) and pass the filename only`
      );
    }
    if (!SAMPLE_EXTS.has(ext)) {
      throw new Error(`Voice sample must be an audio file (${[...SAMPLE_EXTS].join(", ")})`);
    }
    const replaced = (await loadRegistry(voicesDir)).some((e) => e.name === name);

    await uploadUpstream({ config, fetchImpl, samplePath, sampleBytes: maxSampleBytes },
      { name, consent, refText, speakerDescription }, signal);
    if (signal.aborted) throw signal.reason || new Error("Job canceled");

    const audio = await readBoundedFile(samplePath, maxSampleBytes);
    const stored = await storeSample(voicesDir, {
      name,
      consent,
      refText,
      language: language || undefined,
      speakerDescription,
      createdAt: new Date().toISOString(),
      sampleMime: SAMPLE_MIMES[ext],
    }, samplePath, audio.length);

    // Store-resident sources are consumed (move semantics): the inbox/ or
    // root-level drop becomes the managed samples/ copy. Project-asset
    // sources stay untouched.
    if (fromStore && stored.samplePath !== samplePath) {
      await fs.unlink(samplePath).catch(() => {});
    }

    return { artifacts: [], warnings: replaced ? [`voice "${name}" already existed; sample and metadata replaced`] : [] };
  };
}

// ── list_voices: merged upstream + stored view ───────────────────────────────

export async function listVoices({ env = process.env, voicesDir, fetchImpl = globalThis.fetch } = {}) {
  const config = getTtsApiConfig(env);
  const endpoint = ttsApiUrl(config.baseUrl, "/v1/audio/voices");
  if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch");
  const response = await fetchImpl(endpoint, { headers: authHeaders(config, "application/json"), redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`TTS voices API returned HTTP ${response.status}`);
  }
  const upstream = await ensureJson(response, DEFAULT_MAX_RESPONSE_BYTES);
  if (!upstream || typeof upstream !== "object" || Array.isArray(upstream)) {
    throw new Error("TTS voices API response is not a voice registry object");
  }
  const upstreamNames = new Set(Array.isArray(upstream.voices) ? upstream.voices : []);
  let clones = [];
  let inbox = [];
  if (voicesDir) {
    const uploadedNames = upstreamVoicesNames(upstream);
    clones = (await loadRegistry(voicesDir)).map((entry) => ({
      name: entry.name,
      refText: entry.refText || null,
      language: entry.language || null,
      speakerDescription: entry.speakerDescription || null,
      createdAt: entry.createdAt || null,
      sampleSize: entry.sampleSize ?? null,
      sampleFile: entry.sampleFile ? `voices/samples/${entry.sampleFile}` : null,
      // Fish Audio S2 (ComfyUI) clones from sample + exact transcript per job;
      // legacy entries registered before refText became required cannot be used there.
      fishReady: Boolean(entry.refText),
      availableUpstream: upstreamNames.has(entry.name) || uploadedNames.includes(entry.name),
    }));
    inbox = await listInbox(voicesDir);
  }
  return { voices: upstream.voices, uploaded_voices: upstream.uploaded_voices, clones, inbox, cache_stats: upstream.cache_stats };
}

function upstreamVoicesNames(upstream) {
  return Array.isArray(upstream.uploaded_voices)
    ? upstream.uploaded_voices.map((v) => (typeof v === "string" ? v : v?.name)).filter(Boolean)
    : [];
}

// ── Durability: re-register an evicted clone from the store ──────────────────

/**
 * Re-upload a stored clone upstream (its cached encoding was evicted or the
 * upstream restarted). Uses the consent stored at clone time.
 * Returns true when a re-registration happened; false when nothing to do;
 * throws on upstream rejection. Never stores again (identity unchanged).
 */
export async function reRegisterVoice({ env = process.env, voicesDir, fetchImpl = globalThis.fetch, maxSampleBytes = positiveInt(env.TTS_API_MAX_SAMPLE_BYTES, DEFAULT_MAX_SAMPLE_BYTES) } = {}, name, signal) {
  if (!voicesDir) return false;
  const config = getTtsApiConfig(env);
  const entry = (await loadRegistry(voicesDir)).find((e) => e.name === name);
  if (!entry) return false;
  const { samplesDir } = storeRoots(voicesDir);
  const samplePath = path.join(samplesDir, entry.sampleFile);
  await uploadUpstream({ config, fetchImpl, samplePath, sampleBytes: maxSampleBytes },
    { name: entry.name, consent: entry.consent, refText: entry.refText, speakerDescription: entry.speakerDescription }, signal);
  return true;
}

// ── tts_delete_voice ─────────────────────────────────────────────────────────

export async function deleteVoice({ env = process.env, voicesDir, fetchImpl = globalThis.fetch } = {}, name, signal) {
  const clean = validateName(name);
  if (clean === "default") {
    throw new Error('"default" is the built-in voice and cannot be deleted');
  }
  if (!voicesDir) throw new Error("No voice store configured (HF_VOICES_DIR)");
  const registry = await loadRegistry(voicesDir);
  if (!registry.some((e) => e.name === clean)) {
    throw new Error(`no stored clone named "${clean}" — list_voices shows what exists`);
  }
  const config = getTtsApiConfig(env);
  const endpoint = ttsApiUrl(config.baseUrl, `/v1/audio/voices/${encodeURIComponent(clean)}`);
  if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch");
  const response = await fetchImpl(endpoint, { method: "DELETE", headers: authHeaders(config, "application/json"), signal, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`TTS voices API returned HTTP ${response.status}`);
  }
  await ensureJson(response, DEFAULT_MAX_RESPONSE_BYTES).catch(() => ({}));
  await removeFromStore(voicesDir, clean);
  return { deleted: clean };
}
