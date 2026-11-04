import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTtsApiRunner } from "../src/tts-api.js";

const BASE_ENV = {
  TTS_API_MODEL: "tts-test-model",
  TTS_API_VOICE: "test-voice",
  TTS_API_API_KEY: "test-secret",
};

function makeWav() {
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

async function startService(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function makeInput(t, content = "Hello from a project asset.") {
  const workspace = await mkdtemp(path.join(tmpdir(), "hf-tts-"));
  const projectDir = path.join(workspace, "project");
  const assetsDir = path.join(projectDir, "assets", "narration");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(path.join(assetsDir, "script.txt"), content);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return { workspace, assetsDir };
}

function job(id = "job-test") {
  return { id, project: "project", params: { filename: "narration/script.txt" } };
}

test("posts the OpenAI-compatible request and publishes only this job's WAV artifact", async (t) => {
  const wav = makeWav();
  let observed;
  const service = await startService(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "audio/wav" });
    response.end(wav);
  });
  t.after(service.close);
  const { workspace, assetsDir } = await makeInput(t);
  const runner = createTtsApiRunner({ env: { ...BASE_ENV, TTS_API_BASE_URL: service.baseUrl } });

  const result = await runner(job(), { workspace, signal: new AbortController().signal });

  assert.deepEqual(result.artifacts, ["assets/narration/script.job-test.wav"]);
  assert.equal(observed.method, "POST");
  assert.equal(observed.url, "/v1/audio/speech");
  assert.equal(observed.headers.authorization, "Bearer test-secret");
  assert.deepEqual(observed.body, {
    model: "tts-test-model",
    input: "Hello from a project asset.",
    voice: "test-voice",
    response_format: "wav",
  });
  assert.deepEqual(await readFile(path.join(assetsDir, "script.job-test.wav")), wav);
  assert.deepEqual((await readdir(assetsDir)).sort(), ["script.job-test.wav", "script.txt"]);
});

test("does not leak remote error bodies or create output on service errors", async (t) => {
  const service = await startService((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ detail: "private upstream diagnostic" }));
  });
  t.after(service.close);
  const { workspace, assetsDir } = await makeInput(t);
  const runner = createTtsApiRunner({ env: { ...BASE_ENV, TTS_API_BASE_URL: service.baseUrl } });

  await assert.rejects(
    () => runner(job(), { workspace, signal: new AbortController().signal }),
    (error) => error.message.includes("HTTP 503") && !error.message.includes("private upstream diagnostic")
  );
  assert.deepEqual(await readdir(assetsDir), ["script.txt"]);
});

test("rejects malformed or non-WAV successful responses", async (t) => {
  const service = await startService((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("not-a-wav");
  });
  t.after(service.close);
  const { workspace, assetsDir } = await makeInput(t);
  const runner = createTtsApiRunner({ env: { ...BASE_ENV, TTS_API_BASE_URL: service.baseUrl } });

  await assert.rejects(
    () => runner(job(), { workspace, signal: new AbortController().signal }),
    /audio\/wav content type/
  );
  assert.deepEqual(await readdir(assetsDir), ["script.txt"]);
});

test("rejects WAV headers with truncated chunk data", async (t) => {
  const malformed = makeWav();
  malformed.writeUInt32LE(1024, 40);
  const service = await startService((_request, response) => {
    response.writeHead(200, { "content-type": "audio/wav" });
    response.end(malformed);
  });
  t.after(service.close);
  const { workspace, assetsDir } = await makeInput(t);
  const runner = createTtsApiRunner({ env: { ...BASE_ENV, TTS_API_BASE_URL: service.baseUrl } });

  await assert.rejects(
    () => runner(job(), { workspace, signal: new AbortController().signal }),
    /WAV/
  );
  assert.deepEqual(await readdir(assetsDir), ["script.txt"]);
});

test("rejects oversized text before contacting TTS API and rejects oversized audio", async (t) => {
  let requests = 0;
  const service = await startService((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "audio/wav" });
    response.end(makeWav());
  });
  t.after(service.close);
  const { workspace, assetsDir } = await makeInput(t, "text that exceeds the limit");
  const base = { ...BASE_ENV, TTS_API_BASE_URL: service.baseUrl };
  const textLimited = createTtsApiRunner({ env: { ...base, TTS_API_MAX_TEXT_BYTES: "5" } });
  await assert.rejects(
    () => textLimited(job(), { workspace, signal: new AbortController().signal }),
    /text exceeds/
  );
  assert.equal(requests, 0);

  const audioLimited = createTtsApiRunner({ env: { ...base, TTS_API_MAX_AUDIO_BYTES: "40" } });
  await assert.rejects(
    () => audioLimited(job(), { workspace, signal: new AbortController().signal }),
    /response exceeds/
  );
  assert.equal(requests, 1);
  assert.deepEqual(await readdir(assetsDir), ["script.txt"]);
});

test("rejects malformed UTF-8 text without sending it to the service", async (t) => {
  let requests = 0;
  const service = await startService((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "audio/wav" });
    response.end(makeWav());
  });
  t.after(service.close);
  const { workspace, assetsDir } = await makeInput(t, Buffer.from([0xc3, 0x28]));
  const runner = createTtsApiRunner({ env: { ...BASE_ENV, TTS_API_BASE_URL: service.baseUrl } });

  await assert.rejects(
    () => runner(job(), { workspace, signal: new AbortController().signal }),
    /valid UTF-8/
  );
  assert.equal(requests, 0);
  assert.deepEqual(await readdir(assetsDir), ["script.txt"]);
});

test("per-call voice param overrides the configured voice", async (t) => {
  let observed;
  const service = await startService(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "audio/wav" });
    response.end(makeWav());
  });
  t.after(service.close);
  const { workspace } = await makeInput(t);
  const runner = createTtsApiRunner({ env: { ...BASE_ENV, TTS_API_BASE_URL: service.baseUrl } });

  await runner({ ...job("v1"), params: { ...job("v1").params, voice: "cloned-narrator" } }, { workspace, signal: new AbortController().signal });
  assert.equal(observed.voice, "cloned-narrator");

  await runner({ ...job("v2"), params: { ...job("v2").params } }, { workspace, signal: new AbortController().signal });
  assert.equal(observed.voice, "test-voice");

  await assert.rejects(
    () => createTtsApiRunner({ env: { TTS_API_BASE_URL: service.baseUrl, TTS_API_MODEL: "m" }})(
      { ...job("v3"), params: { ...job("v3").params, voice: "" } },
      { workspace, signal: new AbortController().signal }
    ),
    /TTS_API_VOICE/
  );
});

test("aborts an in-flight HTTP request when the shared job signal is canceled", async (t) => {
  let accepted;
  const requestStarted = new Promise((resolve) => { accepted = resolve; });
  const service = await startService((request) => {
    accepted();
    request.on("close", () => {});
  });
  t.after(service.close);
  const { workspace, assetsDir } = await makeInput(t);
  const runner = createTtsApiRunner({ env: { ...BASE_ENV, TTS_API_BASE_URL: service.baseUrl } });
  const controller = new AbortController();
  const running = runner(job(), { workspace, signal: controller.signal });
  await requestStarted;
  controller.abort(new Error("canceled by test"));

  await assert.rejects(running);
  assert.deepEqual(await readdir(assetsDir), ["script.txt"]);
});

test("fails an unconfigured TTS API runner with an actionable message", async (t) => {
  const { workspace } = await makeInput(t);
  const runner = createTtsApiRunner({ env: {} });

  await assert.rejects(
    () => runner(job(), { workspace, signal: new AbortController().signal }),
    /TTS_API_BASE_URL/
  );
});
