import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { JobQueue } from "../src/jobs.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeQueue({ concurrency = 1 } = {}) {
  const jobsDir = await mkdtemp(path.join(tmpdir(), "hf-queue-"));
  const queue = new JobQueue({
    node: process.execPath,
    cli: "unused",
    workspace: jobsDir,
    jobsDir,
    concurrency,
  });
  await queue.ready;
  return { queue, jobsDir };
}

function finished(queue, id) {
  if (["succeeded", "failed", "canceled"].includes(queue.get(id)?.status)) {
    return Promise.resolve(queue.get(id));
  }
  return new Promise((resolve) => {
    const listener = (job) => {
      if (job.id !== id) return;
      queue.off("finished", listener);
      resolve(job);
    };
    queue.on("finished", listener);
  });
}

test("dispatches only registered runners and preserves the shared concurrency limit", async () => {
  const { queue, jobsDir } = await makeQueue({ concurrency: 1 });
  let active = 0;
  let maximum = 0;
  queue.registerRunner("test", async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(25);
    active -= 1;
    return { artifacts: ["assets/result.wav"] };
  });

  assert.throws(() => queue.enqueue({ kind: "unregistered" }), /runner/i);
  const first = queue.enqueue({ kind: "test", project: "p", params: { input: "assets/a.txt" } });
  const second = queue.enqueue({ kind: "test", project: "p", params: { input: "assets/b.txt" } });
  await Promise.all([finished(queue, first.id), finished(queue, second.id)]);

  assert.equal(maximum, 1);
  assert.deepEqual(first.artifacts, ["assets/result.wav"]);
  assert.deepEqual(second.outputs, []);
  await rm(jobsDir, { recursive: true, force: true });
});

test("cancels queued and running runners and releases their queue slots", async () => {
  const { queue, jobsDir } = await makeQueue({ concurrency: 1 });
  queue.registerRunner("blocking", (_rec, { signal }) => new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
  }));

  const running = queue.enqueue({ kind: "blocking" });
  const runningFinished = finished(queue, running.id);
  while (queue.get(running.id).status !== "running") await delay(1);
  const queued = queue.enqueue({ kind: "blocking" });

  assert.deepEqual(queue.cancel(queued.id), { ok: true, status: "canceled" });
  assert.deepEqual(queue.cancel(running.id), { ok: true, status: "canceling" });
  await runningFinished;
  assert.equal(queue.get(running.id).status, "canceled");
  assert.equal(queue.get(queued.id).status, "canceled");
  assert.equal(queue.stats().running, 0);
  await rm(jobsDir, { recursive: true, force: true });
});

test("cancellation during startup does not launch the runner", async () => {
  const { queue, jobsDir } = await makeQueue();
  let invoked = false;
  queue.registerRunner("startup-race", async () => {
    invoked = true;
  });

  const job = queue.enqueue({ kind: "startup-race" });
  const completed = finished(queue, job.id);
  queue.cancel(job.id);
  await completed;

  assert.equal(invoked, false);
  assert.equal(queue.get(job.id).status, "canceled");
  assert.equal(queue.stats().running, 0);
  await rm(jobsDir, { recursive: true, force: true });
});

test("cancellation terminates a subprocess started by a registered runner", async () => {
  const { queue, jobsDir } = await makeQueue();
  queue.registerRunner("subprocess", (_rec, context) => new Promise((resolve, reject) => {
    const child = context.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (context.signal.aborted) reject(context.signal.reason || new Error("aborted"));
      else if (signal || code !== 0) reject(new Error("subprocess failed"));
      else resolve();
    });
  }));

  const job = queue.enqueue({ kind: "subprocess" });
  const completed = finished(queue, job.id);
  while (queue.get(job.id).status !== "running" || !queue.children.has(job.id)) await delay(1);
  queue.cancel(job.id);
  await completed;

  assert.equal(queue.get(job.id).status, "canceled");
  assert.equal(queue.children.has(job.id), false);
  assert.equal(queue.stats().running, 0);
  await rm(jobsDir, { recursive: true, force: true });
});

test("cleans a published artifact when cancellation wins before runner completion", async (t) => {
  const { queue, jobsDir } = await makeQueue();
  t.after(() => rm(jobsDir, { recursive: true, force: true }));
  const output = path.join(jobsDir, "published.wav");
  let published;
  let release;
  const publishedPromise = new Promise((resolve) => { published = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  queue.registerRunner("late-publication", async () => {
    await writeFile(output, "audio");
    published();
    await releasePromise;
    return { artifacts: ["assets/published.wav"], cleanup: () => rm(output, { force: true }) };
  });

  const job = queue.enqueue({ kind: "late-publication" });
  const completed = finished(queue, job.id);
  await publishedPromise;
  queue.cancel(job.id);
  release();
  await completed;

  assert.equal(queue.get(job.id).status, "canceled");
  assert.deepEqual(queue.get(job.id).artifacts, []);
  await assert.rejects(() => access(output));
});

test("cleans a published artifact when a timeout wins before runner completion", async (t) => {
  const { queue, jobsDir } = await makeQueue();
  t.after(() => rm(jobsDir, { recursive: true, force: true }));
  const output = path.join(jobsDir, "published.wav");
  queue.registerRunner("late-timeout", async (_rec, { signal }) => {
    await writeFile(output, "audio");
    if (!signal.aborted) {
      await new Promise((resolve) => {
        const fallback = setTimeout(resolve, 1000);
        signal.addEventListener("abort", () => {
          clearTimeout(fallback);
          resolve();
        }, { once: true });
      });
    }
    return { artifacts: ["assets/published.wav"], cleanup: () => rm(output, { force: true }) };
  });

  const job = queue.enqueue({ kind: "late-timeout", timeoutMs: 50 });
  await finished(queue, job.id);

  assert.equal(queue.get(job.id).status, "failed");
  assert.match(queue.get(job.id).error, /timed out/i);
  assert.deepEqual(queue.get(job.id).artifacts, []);
  await assert.rejects(() => access(output));
});

test("marks persisted queued and running jobs failed after a restart", async () => {
  const jobsDir = await mkdtemp(path.join(tmpdir(), "hf-queue-restart-"));
  const interrupted = {
    id: "interrupted-job",
    kind: "test",
    status: "running",
    createdAt: new Date().toISOString(),
    outputs: [],
  };
  await writeFile(path.join(jobsDir, `${interrupted.id}.json`), JSON.stringify(interrupted));
  const queue = new JobQueue({
    node: process.execPath,
    cli: "unused",
    workspace: jobsDir,
    jobsDir,
  });
  await queue.ready;

  assert.equal(queue.get(interrupted.id).status, "failed");
  assert.match(queue.get(interrupted.id).error, /restart|reinicio/i);
  await rm(jobsDir, { recursive: true, force: true });
});

test("waitFor keeps a standalone caller alive until its wait timeout", async () => {
  const jobsDir = await mkdtemp(path.join(tmpdir(), "hf-queue-wait-"));
  try {
    const moduleUrl = new URL("../src/jobs.js", import.meta.url).href;
    const script = [
      `import { JobQueue } from ${JSON.stringify(moduleUrl)};`,
      `const queue = new JobQueue({ node: process.execPath, cli: "unused", workspace: ${JSON.stringify(jobsDir)}, jobsDir: ${JSON.stringify(jobsDir)} });`,
      "await queue.ready;",
      'queue.registerRunner("idle", () => new Promise(() => {}));',
      'const job = queue.enqueue({ kind: "idle" });',
      'const result = await queue.waitFor(job.id, 20);',
      "console.log(result.status);",
    ].join("\n");
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000 });
    assert.equal(stdout.trim(), "running");
  } finally {
    await rm(jobsDir, { recursive: true, force: true });
  }
});

test("stores only the runner's exact artifacts, not unrelated asset directory entries", async () => {
  const { queue, jobsDir } = await makeQueue();
  const assets = path.join(jobsDir, "project", "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(assets, "unrelated.wav"), "not this job");
  queue.registerRunner("audio", async () => ({ artifacts: ["assets/generated.job.wav"] }));

  const job = queue.enqueue({ kind: "audio", project: "project" });
  await finished(queue, job.id);

  assert.deepEqual(job.artifacts, ["assets/generated.job.wav"]);
  assert.deepEqual(job.outputs, []);
  const persisted = JSON.parse(await readFile(path.join(jobsDir, `${job.id}.json`), "utf8"));
  assert.equal(persisted.status, "succeeded");
  assert.deepEqual(persisted.artifacts, ["assets/generated.job.wav"]);
  await rm(jobsDir, { recursive: true, force: true });
});