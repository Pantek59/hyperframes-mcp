import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobQueue } from "../src/jobs.js";
import { createWhisperXRunner } from "../src/whisperx.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_WHISPERX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const model = value("--model");
const outputDir = value("--output_dir");
fs.writeFileSync(path.join(process.env.HF_HOME, "args.json"), JSON.stringify(args));
if (model === "hang") setInterval(() => {}, 1000);
if (model === "missing-model") {
  process.stderr.write("Could not load requested model from cache\\n");
  process.exit(3);
}
let transcript = { language: "en", segments: [{ start: 0, end: 1, text: "hello" }] };
if (model !== "unaligned") transcript.segments[0].words = [{ word: "hello", start: 0, end: 1 }];
if (model === "partial") transcript.segments[0].words = [{ word: "hello" }];
if (model === "oversize") transcript.segments[0].text = "x".repeat(5000);
const outputPath = path.join(outputDir, path.parse(args[0]).name + ".json");
fs.writeFileSync(outputPath, model === "malformed" ? "{" : JSON.stringify(transcript));
`;

async function makeQueue(t, { model = "base", timeoutMs = 10000, maxAudioBytes, maxJsonBytes, executable } = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), "hf-whisperx-test-"));
  const projectDir = path.join(workspace, "project");
  const assetsDir = path.join(projectDir, "assets", "audio");
  const jobsDir = path.join(workspace, "jobs");
  const modelCacheDir = path.join(workspace, "model-cache");
  const executablePath = executable || path.join(workspace, "fake-whisperx");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(path.join(assetsDir, "source.wav"), Buffer.from("fake audio bytes"));
  if (!executable) {
    await writeFile(executablePath, FAKE_WHISPERX, { mode: 0o700 });
    await chmod(executablePath, 0o700);
  }
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const env = {
    WHISPERX_EXECUTABLE: executablePath,
    WHISPERX_MODEL: model,
    WHISPERX_MODEL_CACHE_DIR: modelCacheDir,
    ...(maxAudioBytes ? { WHISPERX_MAX_AUDIO_BYTES: String(maxAudioBytes) } : {}),
    ...(maxJsonBytes ? { WHISPERX_MAX_JSON_BYTES: String(maxJsonBytes) } : {}),
  };
  const queue = new JobQueue({
    node: process.execPath,
    cli: "unused",
    workspace,
    jobsDir,
    concurrency: 1,
    defaultTimeoutMs: timeoutMs,
  });
  await queue.ready;
  queue.registerRunner("whisperx_transcribe", createWhisperXRunner({ env }));
  return { queue, workspace, projectDir, assetsDir, modelCacheDir, timeoutMs };
}

function waitForFinished(queue, jobId) {
  const current = queue.get(jobId);
  if (["succeeded", "failed", "canceled"].includes(current.status)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const listener = (job) => {
      if (job.id !== jobId) return;
      queue.off("finished", listener);
      resolve(job);
    };
    queue.on("finished", listener);
  });
}

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await access(filePath);
      return;
    } catch {
      await delay(5);
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function enqueue(queue, { language, timeoutMs } = {}) {
  return queue.enqueue({
    kind: "whisperx_transcribe",
    project: "project",
    params: { filename: "audio/source.wav", language },
    timeoutMs,
  });
}

test("runs the pinned CLI contract on CPU and publishes validated timed JSON", async (t) => {
  const { queue, assetsDir, modelCacheDir } = await makeQueue(t);
  const job = enqueue(queue, { language: "en" });
  const completed = await waitForFinished(queue, job.id);

  assert.equal(completed.status, "succeeded");
  assert.deepEqual(completed.artifacts, [`assets/audio/source.${job.id}.json`]);
  assert.deepEqual(completed.warnings, []);
  const transcript = JSON.parse(await readFile(path.join(assetsDir, `source.${job.id}.json`), "utf8"));
  assert.equal(transcript.segments[0].start, 0);
  assert.equal(transcript.segments[0].end, 1);
  assert.equal(transcript.segments[0].words[0].word, "hello");

  const args = JSON.parse(await readFile(path.join(modelCacheDir, "args.json"), "utf8"));
  assert.equal(args[0], path.join(assetsDir, "source.wav"));
  assert.equal(args[args.indexOf("--device") + 1], "cpu");
  assert.equal(args[args.indexOf("--compute_type") + 1], "int8");
  assert.equal(args[args.indexOf("--output_format") + 1], "json");
  assert.equal(args[args.indexOf("--model") + 1], "base");
  assert.equal(args[args.indexOf("--model_dir") + 1], modelCacheDir);
  assert.equal(args[args.indexOf("--language") + 1], "en");
  assert.equal(args.includes("--diarize"), false);
  const outputDir = args[args.indexOf("--output_dir") + 1];
  await assert.rejects(() => access(outputDir));
});

test("reports missing word alignment while retaining segment timestamps", async (t) => {
  const { queue, assetsDir } = await makeQueue(t, { model: "unaligned" });
  const job = enqueue(queue);
  const completed = await waitForFinished(queue, job.id);

  assert.equal(completed.status, "succeeded");
  assert.match(completed.warnings[0], /Word-level alignment was unavailable or incomplete for language en/);
  const transcript = JSON.parse(await readFile(path.join(assetsDir, `source.${job.id}.json`), "utf8"));
  assert.equal(transcript.segments[0].start, 0);
  assert.equal("words" in transcript.segments[0], false);
});

test("reports partial word alignment without inventing timestamps", async (t) => {
  const { queue, assetsDir } = await makeQueue(t, { model: "partial" });
  const job = enqueue(queue);
  const completed = await waitForFinished(queue, job.id);

  assert.equal(completed.status, "succeeded");
  assert.match(completed.warnings[0], /Word-level alignment/);
  const transcript = JSON.parse(await readFile(path.join(assetsDir, `source.${job.id}.json`), "utf8"));
  assert.deepEqual(transcript.segments[0].words[0], { word: "hello" });
});

test("reports model failures and cleans isolated subprocess output", async (t) => {
  const { queue, modelCacheDir } = await makeQueue(t, { model: "missing-model" });
  const job = enqueue(queue);
  const completed = await waitForFinished(queue, job.id);

  assert.equal(completed.status, "failed");
  assert.match(completed.error, /WhisperX exited with code 3/);
  assert.match(completed.tail.join("\n"), /Could not load requested model/);
  const args = JSON.parse(await readFile(path.join(modelCacheDir, "args.json"), "utf8"));
  await assert.rejects(() => access(args[args.indexOf("--output_dir") + 1]));
});

test("rejects malformed or oversized JSON output and removes temporary output", async (t) => {
  for (const [model, limit, expected] of [
    ["malformed", undefined, /malformed UTF-8 JSON/],
    ["oversize", 100, /JSON output exceeds/],
  ]) {
    const { queue, modelCacheDir } = await makeQueue(t, { model, maxJsonBytes: limit });
    const job = enqueue(queue);
    const completed = await waitForFinished(queue, job.id);
    assert.equal(completed.status, "failed");
    assert.match(completed.error, expected);
    const args = JSON.parse(await readFile(path.join(modelCacheDir, "args.json"), "utf8"));
    await assert.rejects(() => access(args[args.indexOf("--output_dir") + 1]));
  }
});

test("fails clearly when the executable is missing, media is unsupported, or language is invalid", async (t) => {
  const missing = await makeQueue(t, { executable: path.join(tmpdir(), "no-whisperx-executable") });
  const missingJob = enqueue(missing.queue);
  assert.match((await waitForFinished(missing.queue, missingJob.id)).error, /WHISPERX_EXECUTABLE/);

  const media = await makeQueue(t);
  await writeFile(path.join(media.assetsDir, "notes.txt"), "not audio");
  const unsupported = media.queue.enqueue({
    kind: "whisperx_transcribe",
    project: "project",
    params: { filename: "audio/notes.txt" },
  });
  assert.match((await waitForFinished(media.queue, unsupported.id)).error, /supported audio asset/);

  const invalidLanguage = enqueue(media.queue, { language: "../en" });
  assert.match((await waitForFinished(media.queue, invalidLanguage.id)).error, /language code/);
});

test("enforces audio size limits before starting the subprocess", async (t) => {
  const { queue, modelCacheDir } = await makeQueue(t, { maxAudioBytes: 2 });
  const job = enqueue(queue);
  const completed = await waitForFinished(queue, job.id);

  assert.equal(completed.status, "failed");
  assert.match(completed.error, /audio exceeds/);
  await assert.rejects(() => access(path.join(modelCacheDir, "args.json")));
});

test("cancels the WhisperX subprocess and removes temporary output", async (t) => {
  const { queue, modelCacheDir } = await makeQueue(t, { model: "hang" });
  const job = enqueue(queue);
  const completedPromise = waitForFinished(queue, job.id);
  while (queue.get(job.id).status !== "running" || !queue.children.has(job.id)) await delay(5);
  await waitForFile(path.join(modelCacheDir, "args.json"));
  queue.cancel(job.id);
  const completed = await completedPromise;

  assert.equal(completed.status, "canceled");
  const args = JSON.parse(await readFile(path.join(modelCacheDir, "args.json"), "utf8"));
  await assert.rejects(() => access(args[args.indexOf("--output_dir") + 1]));
  assert.deepEqual(queue.stats().running, 0);
});

test("times out the WhisperX subprocess and removes temporary output", async (t) => {
  const { queue, modelCacheDir } = await makeQueue(t, { model: "hang" });
  const job = enqueue(queue, { timeoutMs: 1000 });
  const completed = await waitForFinished(queue, job.id);

  assert.equal(completed.status, "failed");
  assert.match(completed.error, /timed out/i);
  await waitForFile(path.join(modelCacheDir, "args.json"));
  const args = JSON.parse(await readFile(path.join(modelCacheDir, "args.json"), "utf8"));
  await assert.rejects(() => access(args[args.indexOf("--output_dir") + 1]));
});