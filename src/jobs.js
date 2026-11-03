/**
 * jobs.js — persistent, concurrency-limited job queue for heavy HyperFrames
 * operations (render, snapshot). Keeps the HTTP request short: the MCP tool
 * enqueues a job and returns a job_id; the agent polls get_job / wait_job.
 *
 * State lives on disk (one JSON file per job) under HF_JOBS_DIR so status
 * survives container restarts, plus a bounded in-memory tail of the CLI log.
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const JOBS_DIR = path.resolve(process.env.HF_JOBS_DIR || "/data/jobs");
const CONCURRENCY = Math.max(1, parseInt(process.env.HF_JOB_CONCURRENCY || "1", 10));
const TAIL_LINES = Math.max(20, parseInt(process.env.HF_JOB_TAIL_LINES || "200", 10));

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

// Cap for the artifact manifest collected per job, so a huge png-sequence
// render (one file per frame) cannot flood job results.
const MAX_LISTED_OUTPUTS = 500;

/**
 * Top-level entries of a job's outputDir; one directory level is unfolded so
 * png-sequence output (a directory of flat PNG frames) shows up as individual
 * downloadable files instead of a bare directory link.
 */
async function listDirEntries(dir) {
  const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const sorted = dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out = [];
  for (const de of sorted) {
    if (de.isFile()) {
      out.push(de.name);
      if (out.length >= MAX_LISTED_OUTPUTS) return out;
    } else if (de.isDirectory()) {
      const sub = await fs
        .readdir(path.join(dir, de.name), { withFileTypes: true })
        .catch(() => []);
      const subSorted = sub.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const s of subSorted) {
        if (!s.isFile()) continue;
        out.push(`${de.name}/${s.name}`);
        if (out.length >= MAX_LISTED_OUTPUTS) return out;
      }
    }
  }
  return out;
}
export { listDirEntries };

function nowIso() {
  return new Date().toISOString();
}

export class JobQueue extends EventEmitter {
  constructor({ node, cli, workspace, defaultTimeoutMs = 1800000, jobsDir = JOBS_DIR, concurrency = CONCURRENCY }) {
    super();
    this.node = node;
    this.cli = cli;
    this.workspace = workspace;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.jobsDir = path.resolve(jobsDir);
    this.concurrency = Math.max(1, concurrency);
    this.jobs = new Map();
    this.pending = [];
    this.running = 0;
    this.children = new Map(); // jobId -> ChildProcess
    this.controllers = new Map();
    this.runners = new Map();
    this.persistChains = new Map();
    this.registerRunner("render", (rec, context) => this.#runCli(rec, context));
    this.registerRunner("snapshot", (rec, context) => this.#runCli(rec, context));
    this.ready = this.#init();
  }

  async #init() {
    await fs.mkdir(this.jobsDir, { recursive: true });
    const files = await fs.readdir(this.jobsDir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await fs.readFile(path.join(this.jobsDir, f), "utf8"));
        // A job left "running" cannot have survived the restart.
        if (rec.status === "running" || rec.status === "queued") {
          rec.status = "failed";
          rec.error = "interrumpido por reinicio del servidor";
          rec.finishedAt = rec.finishedAt || nowIso();
          await this.#persist(rec);
        }
        this.jobs.set(rec.id, rec);
      } catch {
        /* ignore corrupt job files */
      }
    }
    this.emit("ready");
  }

  async #persist(rec) {
    const fp = path.join(this.jobsDir, `${rec.id}.json`);
    const tmp = `${fp}.${randomUUID()}.tmp`;
    const snapshot = JSON.stringify(rec, null, 2);
    const previous = this.persistChains.get(rec.id) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        await fs.writeFile(tmp, snapshot);
        await fs.rename(tmp, fp);
      })
      .catch(() => {})
      .finally(() => {
        fs.unlink(tmp).catch(() => {});
        if (this.persistChains.get(rec.id) === current) this.persistChains.delete(rec.id);
      });
    this.persistChains.set(rec.id, current);
    await current;
  }

  #tail(rec, chunk) {
    rec.tail = rec.tail || [];
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      rec.tail.push(line);
    }
    if (rec.tail.length > TAIL_LINES) rec.tail = rec.tail.slice(-TAIL_LINES);
  }

  registerRunner(kind, runner) {
    if (typeof kind !== "string" || !kind || typeof runner !== "function") {
      throw new TypeError("A runner requires a non-empty kind and a function");
    }
    if (this.runners.has(kind)) throw new Error(`Runner already registered for ${kind}`);
    this.runners.set(kind, runner);
  }

  enqueue({ kind, project, argv, cwd, timeoutMs, outputDir, params = {} }) {
    if (!this.runners.has(kind)) throw new Error(`No runner registered for job kind: ${kind}`);
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new TypeError("Job params must be a serializable object");
    }
    let serializedParams;
    try {
      serializedParams = JSON.stringify(params);
      if (serializedParams === undefined) throw new Error("params are not serializable");
      serializedParams = JSON.parse(serializedParams);
    } catch (error) {
      throw new TypeError(`Job params must be serializable: ${error.message}`);
    }
    if (argv !== undefined && (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string"))) {
      throw new TypeError("Job argv must be an array of strings");
    }
    const rec = {
      id: randomUUID(),
      kind,
      project: project || null,
      argv: argv || [],
      params: serializedParams,
      cwd: cwd || this.workspace,
      status: "queued",
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
      outputDir: outputDir || null,
      outputs: [],
      artifacts: [],
      warnings: [],
      tail: [],
      timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
    };
    this.jobs.set(rec.id, rec);
    this.pending.push(rec.id);
    this.#persist(rec);
    this.emit("enqueued", rec);
    this.#drain();
    return rec;
  }

  #drain() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift();
      const rec = this.jobs.get(id);
      if (!rec || rec.status !== "queued") continue;
      this.#run(rec);
    }
  }

  async #runCli(rec, context) {
    await fs.mkdir(rec.cwd, { recursive: true });
    const child = context.spawn(this.node, [this.cli, ...rec.argv], {
      cwd: rec.cwd,
      env: { HF_WORKSPACE: this.workspace },
    });
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (context.signal.aborted) return reject(context.signal.reason || new Error("Job canceled"));
        if (signal) return reject(new Error(`terminated by signal ${signal}`));
        if (code === 0) return resolve({ exitCode: 0 });
        const error = new Error(`CLI exited with code ${code}`);
        error.exitCode = code;
        reject(error);
      });
    });
  }

  #spawn(rec, command, args, options = {}) {
    const child = spawn(command, args, {
      ...options,
      env: { ...process.env, ...options.env, HF_WORKSPACE: this.workspace },
    });
    this.children.set(rec.id, child);
    child.stdout?.on("data", (chunk) => this.#tail(rec, chunk));
    child.stderr?.on("data", (chunk) => this.#tail(rec, chunk));
    child.once("close", () => {
      if (this.children.get(rec.id) === child) this.children.delete(rec.id);
    });
    if (this.controllers.get(rec.id)?.signal.aborted) child.kill("SIGKILL");
    return child;
  }

  #validArtifacts(artifacts) {
    if (artifacts === undefined) return [];
    if (!Array.isArray(artifacts)) throw new TypeError("Runner artifacts must be an array");
    const normalized = [];
    for (const artifact of artifacts) {
      if (typeof artifact !== "string" || !artifact || artifact.includes("\\") || path.posix.isAbsolute(artifact)) {
        throw new TypeError("Runner artifacts must be project-relative paths");
      }
      const parts = artifact.split("/");
      if (parts.some((part) => !part || part === "." || part === "..")) {
        throw new TypeError("Runner artifacts must be project-relative paths");
      }
      if (!normalized.includes(artifact)) normalized.push(artifact);
    }
    return normalized;
  }

  async #run(rec) {
    this.running += 1;
    const controller = new AbortController();
    this.controllers.set(rec.id, controller);
    rec.status = "running";
    rec.startedAt = nowIso();
    let finished = false;
    let timedOut = false;
    const finish = async (status, result = {}) => {
      if (finished) return;
      finished = true;
      if (rec.status === "canceled") status = "canceled";
      if (status === "succeeded") {
        try {
          rec.artifacts = this.#validArtifacts(result.artifacts);
          rec.warnings = Array.isArray(result.warnings)
            ? result.warnings.filter((warning) => typeof warning === "string").slice(0, 20).map((warning) => warning.slice(0, 1000))
            : [];
        } catch (error) {
          status = "failed";
          result.error = String(error);
        }
      }
      rec.status = status;
      rec.exitCode = result.exitCode ?? (status === "succeeded" ? 0 : null);
      rec.error = status === "canceled" ? null : (result.error ?? null);
      rec.finishedAt = nowIso();
      if (status === "succeeded" && rec.outputDir) {
        rec.outputs = await listDirEntries(rec.outputDir);
      }
      await this.#persist(rec);
      this.children.delete(rec.id);
      this.controllers.delete(rec.id);
      this.running -= 1;
      this.emit("finished", rec);
      this.#drain();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Job timed out after ${rec.timeoutMs}ms`));
      this.children.get(rec.id)?.kill("SIGKILL");
    }, rec.timeoutMs);
    timeout.unref?.();

    try {
      await this.#persist(rec);
      if (rec.status === "canceled") return await finish("canceled");
      this.emit("started", rec);
      const runner = this.runners.get(rec.kind);
      if (!runner) throw new Error(`No runner registered for job kind: ${rec.kind}`);
      const result = await runner(rec, {
        signal: controller.signal,
        workspace: this.workspace,
        log: (chunk) => this.#tail(rec, chunk),
        spawn: (command, args, options) => {
          if (controller.signal.aborted) throw controller.signal.reason || new Error("Job canceled");
          return this.#spawn(rec, command, args, options);
        },
      });
      if (rec.status === "canceled" || controller.signal.aborted) {
        if (typeof result?.cleanup === "function") {
          try {
            await result.cleanup();
          } catch (error) {
            this.#tail(rec, `Artifact cleanup failed: ${error.message}`);
          }
        }
        if (rec.status === "canceled") return await finish("canceled");
        throw controller.signal.reason || new Error("Job canceled");
      }
      await finish("succeeded", result || {});
    } catch (err) {
      if (rec.status === "canceled") await finish("canceled");
      else await finish("failed", {
        exitCode: err?.exitCode ?? null,
        error: String(timedOut ? `Job timed out after ${rec.timeoutMs}ms` : err),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  list(limit = 50) {
    return [...this.jobs.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, Math.max(1, limit));
  }

  cancel(id) {
    const rec = this.jobs.get(id);
    if (!rec) return { ok: false, reason: "job no encontrado" };
    if (TERMINAL.has(rec.status)) return { ok: false, reason: `job ya ${rec.status}` };
    if (rec.status === "queued") {
      this.pending = this.pending.filter((x) => x !== id);
      rec.status = "canceled";
      rec.finishedAt = nowIso();
      this.#persist(rec);
      this.emit("finished", rec);
      this.#drain();
      return { ok: true, status: "canceled" };
    }
    rec.status = "canceled";
    this.#persist(rec);
    this.controllers.get(id)?.abort(new Error("Job canceled"));
    const child = this.children.get(id);
    if (child) child.kill("SIGKILL");
    return { ok: true, status: "canceling" };
  }

  /** Block until a job reaches a terminal state or the timeout elapses. */
  waitFor(id, timeoutMs = 600000) {
    const rec = this.jobs.get(id);
    if (!rec) return Promise.resolve(null);
    if (TERMINAL.has(rec.status)) return Promise.resolve(rec);
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const cur = this.jobs.get(id);
        if (!cur || TERMINAL.has(cur.status)) return resolve(cur);
        if (Date.now() - started >= timeoutMs) return resolve(cur);
        setTimeout(tick, 500);
      };
      tick();
    });
  }

  stats() {
    return {
      concurrency: this.concurrency,
      running: this.running,
      queued: this.pending.length,
      total: this.jobs.size,
    };
  }
}
