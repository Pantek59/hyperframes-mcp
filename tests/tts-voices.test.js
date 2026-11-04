import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTtsUploadVoiceRunner, listVoices } from "../src/tts-voices.js";

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
  const lower = raw.toString("latin1");
  const parts = {};
  for (const chunk of lower.split(`--${boundary}`)) {
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
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return { workspace, samplePath };
}

function job(params) {
  return { id: "job-voices", project: "project", params };
}

test("uploads the multipart registration and reports no artifacts", async (t) => {
  let observed;
  const service = await startService(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      method: request.method,
      url: request.url,
      contentType: request.headers["content-type"],
      authorization: request.headers.authorization,
      parts: parseMultipart(Buffer.concat(chunks), request.headers["content-type"]),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, name: "narrator" }));
  });
  t.after(service.close);
  const { workspace } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: { TTS_API_BASE_URL: service.baseUrl, TTS_API_API_KEY: "k" } });

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
  assert.equal(observed.method, "POST");
  assert.equal(observed.url, "/v1/audio/voices");
  assert.equal(observed.authorization, "Bearer k");
  assert.match(observed.contentType, /^multipart\/form-data;/);
  assert.equal(observed.parts.name, "narrator");
  assert.match(observed.parts.consent, /^I confirm I am the speaker/);
  assert.equal(observed.parts.ref_text, "This is the spoken transcript.");
  assert.equal(observed.parts.speaker_description, "calm adult voice");
  assert.equal(observed.parts.audio_sample.filename, "sample.mp3");
  assert.ok(observed.parts.audio_sample.value.includes("synthetic audio payload"));
});

test("rejects a non-audio sample before contacting the service", async (t) => {
  let requests = 0;
  const service = await startService((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  t.after(service.close);
  const { workspace } = await makeProject(t, "notes/sample.txt", Buffer.from("just text"));
  const runner = createTtsUploadVoiceRunner({ env: { TTS_API_BASE_URL: service.baseUrl } });

  await assert.rejects(
    () => runner(job({ filename: "notes/sample.txt", name: "x", consent: "y" }), { workspace, signal: new AbortController().signal }),
    /must be an audio file/
  );
  assert.equal(requests, 0);
});

test("rejects missing consent or an unsafe name without contacting the service", async (t) => {
  let requests = 0;
  const service = await startService((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  t.after(service.close);
  const { workspace } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: { TTS_API_BASE_URL: service.baseUrl } });
  const ctx = { workspace, signal: new AbortController().signal };

  await assert.rejects(() => runner(job({ filename: "narration/sample.mp3", name: "x" }), ctx), /consent/);
  await assert.rejects(() => runner(job({ filename: "narration/sample.mp3", consent: "ok", name: "../evil" }), ctx), /Voice name/);
  await assert.rejects(() => runner(job({ filename: "narration/sample.mp3", consent: "ok", name: "with space" }), ctx), /Voice name/);
  assert.equal(requests, 0);
});

test("rejects oversized samples before uploading", async (t) => {
  let requests = 0;
  const service = await startService((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  t.after(service.close);
  const { workspace } = await makeProject(t, "narration/big.mp3", Buffer.alloc(100));
  const runner = createTtsUploadVoiceRunner({
    env: { TTS_API_BASE_URL: service.baseUrl, TTS_API_MAX_SAMPLE_BYTES: "50" },
  });

  await assert.rejects(
    () => runner(job({ filename: "narration/big.mp3", name: "x", consent: "ok" }), { workspace, signal: new AbortController().signal }),
    /exceeds the 50-byte limit/
  );
  assert.equal(requests, 0);
});

test("never leaks remote error bodies", async (t) => {
  const service = await startService((_req, res) => {
    res.writeHead(422, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "private upstream diagnostic" }));
  });
  t.after(service.close);
  const { workspace } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: { TTS_API_BASE_URL: service.baseUrl } });

  await assert.rejects(
    () => runner(job({ filename: "narration/sample.mp3", name: "x", consent: "ok" }), { workspace, signal: new AbortController().signal }),
    (error) => error.message.includes("HTTP 422") && !error.message.includes("private upstream diagnostic")
  );
});

test("rejects a non-JSON success response", async (t) => {
  const service = await startService((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("registered");
  });
  t.after(service.close);
  const { workspace } = await makeProject(t);
  const runner = createTtsUploadVoiceRunner({ env: { TTS_API_BASE_URL: service.baseUrl } });

  await assert.rejects(
    () => runner(job({ filename: "narration/sample.mp3", name: "x", consent: "ok" }), { workspace, signal: new AbortController().signal }),
    /unexpected response type/
  );
});

test("listVoices returns the parsed registry", async (t) => {
  const service = await startService((req, res) => {
    if (req.method !== "GET" || req.url !== "/v1/audio/voices") {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ voices: ["default"], uploaded_voices: ["narrator"] }));
  });
  t.after(service.close);

  const registry = await listVoices({ env: { TTS_API_BASE_URL: service.baseUrl } });
  assert.deepEqual(registry, { voices: ["default"], uploaded_voices: ["narrator"] });
});

test("listVoices and the runner fail with an actionable message when unconfigured", async (t) => {
  await assert.rejects(() => listVoices({ env: {} }), /TTS_API_BASE_URL/);
  const runner = createTtsUploadVoiceRunner({ env: {} });
  await assert.rejects(
    () => runner(job({ filename: "a.mp3", name: "x", consent: "ok" }), { workspace: "/tmp", signal: new AbortController().signal }),
    /TTS_API_BASE_URL/
  );
});

test("accepts wav samples", async (t) => {
  let seen = null;
  const service = await startService(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen = parseMultipart(Buffer.concat(chunks), req.headers["content-type"]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  t.after(service.close);
  const { workspace } = await makeProject(t, "narration/ref.wav", makeJobAudio());
  const runner = createTtsUploadVoiceRunner({ env: { TTS_API_BASE_URL: service.baseUrl } });

  await runner(job({ filename: "narration/ref.wav", name: "ref", consent: "ok" }), { workspace, signal: new AbortController().signal });
  assert.equal(seen.audio_sample.filename, "ref.wav");
});
