import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listDirEntries } from "../src/jobs.js";

test("lists top-level files and unfolds one directory level (png-sequence frames)", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "hf-jobs-"));
  const renders = path.join(ws, "renders");
  await mkdir(path.join(renders, "abc123"), { recursive: true });
  await writeFile(path.join(renders, "a.mp4"), "x");
  await writeFile(path.join(renders, "abc123", "frame_000000.png"), "x");
  await writeFile(path.join(renders, "abc123", "frame_000001.png"), "x");
  const out = await listDirEntries(renders);
  assert.deepEqual(out.sort(), [
    "a.mp4",
    "abc123/frame_000000.png",
    "abc123/frame_000001.png",
  ]);
});

test("caps listed outputs at 500 entries", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "hf-jobs-"));
  const dir = path.join(ws, "out");
  await mkdir(dir);
  for (let i = 0; i < 505; i++) await writeFile(path.join(dir, `f${String(i).padStart(4, "0")}`), "x");
  const out = await listDirEntries(dir);
  assert.equal(out.length, 500);
  assert.deepEqual(out[0], "f0000");
  assert.deepEqual(out[499], "f0499");
});

test("returns [] for a missing output directory", async () => {
  const out = await listDirEntries(path.join(tmpdir(), "hf-jobs-does-not-exist"));
  assert.deepEqual(out, []);
});
