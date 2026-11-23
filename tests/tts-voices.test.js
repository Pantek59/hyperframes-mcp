import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTtsUploadVoiceRunner,
  listVoices,
  listFromStore,
  deleteVoice,
  reRegisterVoice,
  resolveStoreSample,
  listInbox,
  getStoredVoice,
} from "../src/tts-voices.js";

const MP3_BYTES = Buffer.from("ID3 synthetic audio payload for tests", "utf8");

function makeJobAudio() {
  const wav = Buffer.alloc(46);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(2, 40);
  wav.writeInt16LE(100, 44);
  return wav;
}

function parseMultipart(raw, contentType) {
  const boundary = /boundary=([^;]+)/.exec(contentType)[1];
  const text = raw.toString("latin1");
  const parts = {};
  for (const chunk of text.split(`--${boundary}`)) {
    if (!chunk.toLowerCase().includes("content-disposition")) continue;
    const nameMatch = /name="([^"]*)"/.exec(chunk);
    if (!nameMatch) continue;
    const headerEnd = chunk.indexOf("\r\n\r\n");
    const value = chunk.slice(headerEnd + 4).replace(/\r\n$/, "");
    const fileMatch = /filename="([^"]*)"/.exec(chunk);
    parts[nameMatch[1]] = fileMatch ? { filename: fileMatch[1], value } : value;
  }
  return parts;
}

async function startService(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function makeProject(t, sample = "narration/sample.mp3", content = MP3_BYTES) {
  const workspace = await mkdtemp(path.join(tmpdir(), "hf-voices-"));
  const projectDir = path.join(workspace, "project");
  const samplePath = path.join(projectDir, "assets", sample);
  await mkdir(path.dirname(samplePath), { recursive: true });
  await writeFile(samplePath, content);
  const voicesDir = path.join(workspace, "voices-store");
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return { workspace, voicesDir, samplePath };
}

const ENV = (baseUrl) => ({ TTS_API_BASE_URL: baseUrl, TTS_API_API_KEY: "k" });
const job = (params) => ({ id: "job-voices", project: "project", params });
const CTX = { signal: new AbortController().signal };

test("upload registers upstream AND stores the sample + metadata globally", async (t) => {
  let upBody = null;
  let upAuth = null;
  const service = await startService(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    if (request.method === "POST" && request.url === "/v1/audio/voices") {
      upAuth = request.headers.authorization;
      upBody = parseMultipart(raw, request.headers["content-type"]);
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ ok: true }));
    }
    response.writeHead(404);
    response.end();
  });
  t.after(service.close);
  const { workspace, voicesDir } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: ENV(service.baseUrl), voicesDir });

  const result = await runner(
    job({
      filename: "narration/sample.mp3",
      name: "narrator",
      consent: "I confirm I am the speaker in this sample or have their explicit permission.",
      refText: "This is the spoken transcript.",
      speakerDescription: "calm adult voice",
    }),
    { workspace, signal: new AbortController().signal }
  );

  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.warnings, []);
assert.equal(upBody.name, "narrator");
  assert.equal(upAuth, "Bearer k");

  const registry = await listFromStore(voicesDir);
  assert.equal(registry.length, 1);
  const entry = registry[0];
  assert.equal(entry.name, "narrator");
  assert.equal(entry.sampleSize, MP3_BYTES.length);
  assert.equal(entry.sampleMime, "audio/mpeg");
  assert.match(entry.sampleFile, /^narrator\.mp3$/);
  assert.ok((await readFile(path.join(voicesDir, "samples", "narrator.mp3"))).equals(MP3_BYTES));
  assert.match(entry.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("re-registering the same name replaces the store entry with a warning", async (t) => {
  let calls = 0;
  const service = await startService((_request, response) => {
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(service.close);
  const { workspace, voicesDir } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: ENV(service.baseUrl), voicesDir });
  const params = { filename: "narration/sample.mp3", name: "narrator", consent: "ok", refText: "transcript" };
  await runner(job(params), { workspace, signal: new AbortController().signal });
  const result = await runner(job(params), { workspace, signal: new AbortController().signal });

  assert.deepEqual(await listFromStore(voicesDir).then((r) => r.map((e) => e.name)), ["narrator"]);
  assert.ok(result.warnings[0].includes("replaced"));
  assert.equal(calls, 2);
});

test("a failed upstream registration leaves the store untouched", async (t) => {
  const service = await startService((_request, response) => {
    response.writeHead(422, { "content-type": "application/json" });
    response.end(JSON.stringify({ detail: "private upstream diagnostic" }));
  });
  t.after(service.close);
  const { workspace, voicesDir } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: ENV(service.baseUrl), voicesDir });

  await assert.rejects(
    () => runner(job({ filename: "narration/sample.mp3", name: "x", consent: "ok", refText: "t" }), { workspace, signal: new AbortController().signal }),
    (error) => error.message.includes("HTTP 422") && !error.message.includes("private upstream diagnostic")
  );
  assert.deepEqual(await listFromStore(voicesDir), []);
  await assert.rejects(() => readdir(path.join(voicesDir, "samples")), { code: "ENOENT" });
});

test("sample validation happens before any upstream call", async (t) => {
  let calls = 0;
  const service = await startService((_req, res) => {
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  t.after(service.close);
  const { workspace, voicesDir } = await makeProject(t, "notes/sample.txt", Buffer.from("just text"));
  const runner = createTtsUploadVoiceRunner({
    env: { ...ENV(service.baseUrl), TTS_API_MAX_SAMPLE_BYTES: "50" },
    voicesDir: path.join(voicesDir, "cap"),
  });
  const ctx = { workspace, signal: new AbortController().signal };

  await assert.rejects(
    () => runner(job({ filename: "notes/sample.txt", name: "x", consent: "ok", refText: "t" }), ctx),
    /must be an audio file/
  );
  await assert.rejects(
    () => runner(job({ filename: "narration/sample.mp3", name: "with space", consent: "ok", refText: "t" }), { ...ctx, voicesDir }),
    /Voice name/
  );
  assert.throws(
    () => createTtsUploadVoiceRunner({ env: ENV(service.baseUrl) }),
    /voice store/
  );
  const bad = createTtsUploadVoiceRunner({ env: { ...ENV(service.baseUrl), TTS_API_MAX_SAMPLE_BYTES: "50" }, voicesDir });
  const { workspace: ws2 } = await makeProject(t, "narration/big.mp3", Buffer.alloc(100));
  await assert.rejects(() => bad(job({ filename: "narration/big.mp3", name: "x3", consent: "ok", refText: "t" }), { workspace: ws2, signal: new AbortController().signal }), /exceeds the 50-byte limit/);
  assert.equal(calls, 0);
});

test("missing consent is rejected", async (t) => {
  const service = await startService((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  t.after(service.close);
  const { workspace, voicesDir } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: ENV(service.baseUrl), voicesDir });
  await assert.rejects(
    () => runner(job({ filename: "narration/sample.mp3", name: "ok-name" }), { workspace, signal: new AbortController().signal }),
    /consent/
  );
});

test("listVoices merges upstream registry and store with availability flags", async (t) => {
  const service = await startService((req, res) => {
    if (req.method !== "GET" || req.url !== "/v1/audio/voices") {
      if (req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{}");
      }
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      voices: ["default"],
      uploaded_voices: [],
      cache_stats: { entries: 0 },
    }));
  });
  t.after(service.close);
  const { workspace, voicesDir } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: ENV(service.baseUrl), voicesDir });
  await runner(
    job({ filename: "narration/sample.mp3", name: "evicted-clone", consent: "ok", refText: "the registered transcript" }),
    { workspace, signal: new AbortController().signal }
  );

  const merged = await listVoices({ env: ENV(service.baseUrl), voicesDir });
  assert.deepEqual(merged.clones, [
    {
      name: "evicted-clone",
      refText: "the registered transcript",
      language: null,
      speakerDescription: null,
      createdAt: merged.clones[0].createdAt,
      sampleSize: MP3_BYTES.length,
      sampleFile: "voices/samples/evicted-clone.mp3",
      fishReady: true, // has a transcript → usable by the Fish Audio S2 backend
      availableUpstream: false, // upstream evicted it; store still owns the sample
    },
  ]);
  assert.deepEqual(merged.voices, ["default"]);
  assert.deepEqual(merged.cache_stats, { entries: 0 });

  const noStore = await listVoices({ env: ENV(service.baseUrl) });
  assert.deepEqual(noStore.clones, []);
});

test("reRegisterVoice re-uploads the stored sample with stored consent", async (t) => {
  let seen = null;
  const service = await startService(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === "POST" && req.url === "/v1/audio/voices") {
      seen = parseMultipart(Buffer.concat(chunks), req.headers["content-type"]);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{}");
    }
    res.writeHead(404);
    res.end();
  });
  t.after(service.close);
  const { workspace, voicesDir } = await makeProject(t);
  const upload = createTtsUploadVoiceRunner({ env: ENV(service.baseUrl), voicesDir });
  await upload(
    job({ filename: "narration/sample.mp3", name: "narrator", consent: "stored consent", refText: "stored text" }),
    { workspace, signal: new AbortController().signal }
  );

  assert.equal(await reRegisterVoice({ env: ENV(service.baseUrl), voicesDir }, "narrator"), true);
  assert.equal(seen.name, "narrator");
  assert.equal(seen.consent, "stored consent");
  assert.equal(seen.ref_text, "stored text");
  assert.equal(await reRegisterVoice({ env: ENV(service.baseUrl), voicesDir }, "ghost"), false);
});

test("deleteVoice removes upstream and store entries; default is protected", async (t) => {
  let deleteCalls = 0;
  const service = await startService((req, res) => {
    if (req.method === "DELETE" && req.url === "/v1/audio/voices/narrator") {
      deleteCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{}");
    }
    if (req.method === "POST" && req.url === "/v1/audio/voices") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{}");
    }
    res.writeHead(404);
    res.end();
  });
  t.after(service.close);
  const { workspace, voicesDir } = await makeProject(t);
  const upload = createTtsUploadVoiceRunner({ env: ENV(service.baseUrl), voicesDir });
  await upload(
    job({ filename: "narration/sample.mp3", name: "narrator", consent: "ok", refText: "stored text" }),
    { workspace, signal: new AbortController().signal }
  );

  const result = await deleteVoice({ env: ENV(service.baseUrl), voicesDir }, "narrator");
  assert.deepEqual(result, { deleted: "narrator" });
  assert.equal(deleteCalls, 1);
  assert.deepEqual(await listFromStore(voicesDir), []);

  await assert.rejects(() => deleteVoice({ env: ENV(service.baseUrl), voicesDir }, "default"), /cannot be deleted/);
  await assert.rejects(() => deleteVoice({ env: ENV(service.baseUrl), voicesDir }, "ghost"), /no stored clone/);
});

test("a corrupt registry fails safe with an actionable error", async (t) => {
  const service = await startService((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  t.after(service.close);
  const { workspace, voicesDir } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: ENV(service.baseUrl), voicesDir });
  const ctx = { workspace, signal: new AbortController().signal };
  await runner(job({ filename: "narration/sample.mp3", name: "narrator", consent: "ok", refText: "t" }), ctx);
  await writeFile(path.join(voicesDir, "registry.json"), "{corrupt");
  await assert.rejects(
    () => runner(job({ filename: "narration/sample.mp3", name: "narrator", consent: "ok", refText: "t" }), ctx),
    /registry is corrupt/
  );
});

test("store-drop flow: register a voice without any project", async (t) => {
  let seen = null;
  const service = await startService(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === "POST" && req.url === "/v1/audio/voices") {
      seen = parseMultipart(Buffer.concat(chunks), req.headers["content-type"]);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{}");
    }
    res.writeHead(404);
    res.end();
  });
  t.after(service.close);
  const { voicesDir } = await makeProject(t);
  // user drops the sample into inbox/
  await mkdir(path.join(voicesDir, "inbox"), { recursive: true });
  const dropped = path.join(voicesDir, "inbox", "my-voice.mp3");
  await writeFile(dropped, MP3_BYTES);

  const inboxBefore = await listInbox(voicesDir);
  assert.deepEqual(inboxBefore.map((f) => f.file), ["inbox/my-voice.mp3"]);
  assert.equal((await resolveStoreSample(voicesDir, "my-voice.mp3")).ext, "mp3");

  const runner = createTtsUploadVoiceRunner({ env: ENV(service.baseUrl), voicesDir });
  const result = await runner(
    { id: "store-drop", project: null, params: { filename: "inbox/my-voice.mp3", name: "my_voice", consent: "ok", refText: "Mein Transcript.", language: "DE" } },
    { workspace: path.join(path.dirname(voicesDir), "no-project-but-fine"), signal: new AbortController().signal }
  );

  assert.deepEqual(result.artifacts, []);
  assert.equal(seen.name, "my_voice");
  // move semantics: the inbox file is consumed and the canonical copy stored
  await assert.rejects(() => readdir(dropped), { code: "ENOENT" });
  assert.ok((await readFile(path.join(voicesDir, "samples", "my_voice.mp3"))).equals(MP3_BYTES));
  assert.deepEqual(await listInbox(voicesDir), []);
  const droppedEntry = (await listFromStore(voicesDir))[0];
  assert.equal(droppedEntry.name, "my_voice");
  assert.equal(droppedEntry.refText, "Mein Transcript.");
  assert.equal(droppedEntry.language, "de"); // normalized + lowercased
});

test("resolveStoreSample is strict about managed and unsafe paths", async (t) => {
  const { voicesDir } = await makeProject(t);
  await mkdir(path.join(voicesDir, "inbox"), { recursive: true });
  await mkdir(path.join(voicesDir, "samples"), { recursive: true });
  await writeFile(path.join(voicesDir, "inbox", "ok.wav"), "x");
  await writeFile(path.join(voicesDir, "samples", "registered.mp3"), "x");
  await writeFile(path.join(voicesDir, "registry.json"), "[]");

  assert.ok(await resolveStoreSample(voicesDir, "ok.wav"));           // root lookup for inbox file
  assert.ok(await resolveStoreSample(voicesDir, "inbox/ok.wav"));     // explicit inbox lookup
  assert.equal(await resolveStoreSample(voicesDir, "registered.mp3"), null); // samples/ never resolvable by that name alone? — no: samples/<file> requires the "samples/" prefix, which is rejected
  assert.equal(await resolveStoreSample(voicesDir, "samples/registered.mp3"), null);
  assert.equal(await resolveStoreSample(voicesDir, "registry.json"), null);
  assert.equal(await resolveStoreSample(voicesDir, "../escape.wav"), null);
  assert.equal(await resolveStoreSample(voicesDir, ""), null);
  assert.equal(await resolveStoreSample(voicesDir, "notes/sample.txt"), null); // non-audio ext
});

test("a registration without a transcript is rejected before any upstream call", async (t) => {
  let calls = 0;
  const service = await startService((_req, res) => {
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  t.after(service.close);
  const { workspace, voicesDir } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: ENV(service.baseUrl), voicesDir });

  await assert.rejects(
    () => runner(
      job({ filename: "narration/sample.mp3", name: "no-transcript", consent: "ok" }),
      { workspace, signal: new AbortController().signal }
    ),
    /transcript/
  );
  await assert.rejects(
    () => runner(
      job({ filename: "narration/sample.mp3", name: "blank-transcript", consent: "ok", refText: "   " }),
      { workspace, signal: new AbortController().signal }
    ),
    /transcript/
  );
  assert.equal(calls, 0);
  assert.deepEqual(await listFromStore(voicesDir), []);
});

test("an invalid language code is rejected before any upstream call", async (t) => {
  let calls = 0;
  const service = await startService((_req, res) => {
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  t.after(service.close);
  const { workspace, voicesDir } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: ENV(service.baseUrl), voicesDir });

  await assert.rejects(
    () => runner(
      job({ filename: "narration/sample.mp3", name: "bad-lang", consent: "ok", refText: "t", language: "deutsch" }),
      { workspace, signal: new AbortController().signal }
    ),
    /Language must be a 2–3 letter ISO code/
  );
  assert.equal(calls, 0);
});

test("getStoredVoice resolves stored clones with metadata; unknown names and built-ins fail cleanly", async (t) => {
  const service = await startService((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  t.after(service.close);
  const { workspace, voicesDir } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: ENV(service.baseUrl), voicesDir });
  await runner(
    job({ filename: "narration/sample.mp3", name: "narrator", consent: "ok", refText: "the exact transcript", language: "de" }),
    { workspace, signal: new AbortController().signal }
  );

  const stored = await getStoredVoice(voicesDir, "narrator");
  assert.equal(stored.name, "narrator");
  assert.equal(stored.refText, "the exact transcript");
  assert.equal(stored.language, "de");
  assert.equal(stored.entry.consent, "ok");
  assert.equal(stored.samplePath, path.join(voicesDir, "samples", "narrator.mp3"));

  assert.equal(await getStoredVoice(voicesDir, "ghost"), null);
  // invalid syntax throws (validateName), unknown names resolve to null
  await assert.rejects(() => getStoredVoice(voicesDir, "bad name!"), /Voice name/);
  await assert.rejects(() => getStoredVoice(voicesDir, "default"), /built-in voice/);
});

const DEAD_ORIGIN = "http://127.0.0.1:59999";
const refusedFetcher = async () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
};

test("listVoices enriches connection failures with origin + cause code and times out", async (t) => {
  const seen = {};
  const fetchImpl = async (url, init) => {
    seen.url = url;
    seen.signal = init?.signal;
    return refusedFetcher();
  };
  await assert.rejects(
    () => listVoices({ env: ENV(DEAD_ORIGIN), voicesDir: null, fetchImpl }),
    (error) =>
      error.message.includes(`TTS voices API (${DEAD_ORIGIN}) request failed: fetch failed (ECONNREFUSED)`)
  );
  assert.equal(String(seen.url), `${DEAD_ORIGIN}/v1/audio/voices`);
  assert.ok(seen.signal instanceof AbortSignal); // bounded: TTS_API_LIST_TIMEOUT_MS
});

test("listVoices honors TTS_API_LIST_TIMEOUT_MS for the upstream fetch", async () => {
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    // setTimeout keeps a ref'd handle alive while we wait for the (unref'd)
    // AbortSignal.timeout to fire — otherwise the test harness drains the
    // event loop before the rejection settles.
    const keeper = setTimeout(() => reject(new Error("test fixture timed out")), 2000);
    init.signal.addEventListener("abort", () => {
      clearTimeout(keeper);
      reject(init.signal.reason);
    });
  });
  await assert.rejects(
    () => listVoices({ env: { ...ENV(DEAD_ORIGIN), TTS_API_LIST_TIMEOUT_MS: "50" }, voicesDir: null, fetchImpl }),
    (error) =>
      error.message.includes(`TTS voices API (${DEAD_ORIGIN}) request failed`) &&
      /aborted due to timeout|TimeoutError/i.test(error.message)
  );
});

test("tts_upload_voice enriches connection failures with origin + cause code and stores nothing", async (t) => {
  const { workspace, voicesDir } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: ENV(DEAD_ORIGIN), voicesDir, fetchImpl: refusedFetcher });
  await assert.rejects(
    () => runner(job({ filename: "narration/sample.mp3", name: "narrator", consent: "ok", refText: "t" }), { workspace, signal: new AbortController().signal }),
    (error) =>
      error.message.includes(`TTS voices API (${DEAD_ORIGIN}) request failed: fetch failed (ECONNREFUSED)`)
  );
  assert.deepEqual(await listFromStore(voicesDir), []);
});

test("tts_delete_voice enriches connection failures with origin + cause code", async (t) => {
  const service = await startService(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/audio/voices") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{}");
    }
    res.writeHead(404);
    res.end();
  });
  t.after(service.close);
  const { workspace, voicesDir } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: ENV(service.baseUrl), voicesDir });
  await runner(job({ filename: "narration/sample.mp3", name: "narrator", consent: "ok", refText: "t" }), { workspace, signal: new AbortController().signal });

  await assert.rejects(
    () => deleteVoice({ env: ENV(DEAD_ORIGIN), voicesDir, fetchImpl: refusedFetcher }, "narrator"),
    (error) =>
      error.message.includes(`TTS voices API (${DEAD_ORIGIN}) request failed: fetch failed (ECONNREFUSED)`)
  );
  // the store entry survives a failed upstream delete (delete happens after)
  assert.equal((await listFromStore(voicesDir)).length, 1);
});
