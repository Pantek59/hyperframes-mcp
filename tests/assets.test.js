import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listAssets, ASSETS_MAX_DEPTH, ASSETS_MAX_ENTRIES } from "../src/assets.js";

const OUTSIDE = await mkdtemp(path.join(tmpdir(), "hf-outside-"));

async function makeProject({ withAssets = true } = {}) {
  const ws = await mkdtemp(path.join(tmpdir(), "hf-ws-"));
  const project = path.join(ws, "proj");
  await mkdir(project, { recursive: true });
  if (withAssets) await mkdir(path.join(project, "assets"), { recursive: true });
  return { ws, project };
}

test("lists uploaded files with project-relative paths, size, mtime and type", async () => {
  const { project } = await makeProject();
  await writeFile(path.join(project, "assets", "logo.png"), Buffer.alloc(10, 1));
  await writeFile(path.join(project, "assets", "voice 1.mp3"), Buffer.alloc(5, 2));
  const { files, truncated } = await listAssets(project);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(files.length, 2);
  assert.deepEqual(byPath["assets/logo.png"].type, "image");
  assert.equal(byPath["assets/logo.png"].size, 10);
  assert.ok(byPath["assets/logo.png"].modified);
  assert.deepEqual(byPath["assets/voice 1.mp3"].type, "audio");
  assert.equal(truncated, false);
});

test("project without assets/ is not an error: empty list", async () => {
  const { project } = await makeProject({ withAssets: false });
  assert.deepEqual(await listAssets(project), { files: [], truncated: false });
});

test("dotfiles are ignored", async () => {
  const { project } = await makeProject();
  await writeFile(path.join(project, "assets", ".hidden"), "x");
  assert.deepEqual((await listAssets(project)).files, []);
});

test("recursion is capped at max depth", async () => {
  const { project } = await makeProject();
  const a1 = path.join(project, "assets", "d1");
  const a2 = path.join(a1, "d2");
  const a3 = path.join(a2, "d3");
  const a4 = path.join(a3, "d4");
  await mkdir(a4, { recursive: true });
  await writeFile(path.join(a3, "ok.png"), "x"); // d1/d2/d3 = 3 levels -> listed
  await writeFile(path.join(a4, "too-deep.png"), "x"); // 4 levels -> skipped
  const { files } = await listAssets(project);
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes("assets/d1/d2/d3/ok.png"));
  assert.equal(paths.length, 1);
});

test("entry cap at 500 with truncated flag", async () => {
  const { project } = await makeProject();
  for (let i = 0; i < ASSETS_MAX_ENTRIES + 5; i++) {
    await writeFile(path.join(project, "assets", `f${String(i).padStart(4, "0")}.jpg`), "x");
  }
  const { files, truncated } = await listAssets(project);
  assert.equal(files.length, ASSETS_MAX_ENTRIES);
  assert.equal(truncated, true);
});

test("subdir escaping assets/ throws", async () => {
  const { ws, project } = await makeProject();
  await mkdir(path.join(ws, "compositions"), { recursive: true });
  await writeFile(path.join(ws, "compositions", "intro.html"), "x");
  await assert.rejects(() => listAssets(project, "../compositions"), /escapa/);
  await assert.rejects(() => listAssets(project, "../../"), /escapa/);
});

test("nonexistent subdir throws", async () => {
  const { project } = await makeProject();
  await assert.rejects(() => listAssets(project, "missing"), /no existe/);
});

test("symlink escape is not listed (junction/symlink tolerated)", async () => {
  const { ws, project } = await makeProject();
  const outsideFile = path.join(OUTSIDE, "secret.txt");
  await writeFile(outsideFile, "x");
  let created = false;
  try {
    await symlink(OUTSIDE, path.join(project, "assets", "outside"), "junction");
    created = true;
  } catch {
    try {
      await symlink(outsideFile, path.join(project, "assets", "outside.txt"));
      created = true;
    } catch {
      /* no symlink privilege: skip this test scenario */
    }
  }
  const { files } = await listAssets(project);
  if (created) assert.equal(files.length, 0);
  else assert.equal(files.length, 0); // assets empty regardless
  await rm(path.join(ws), { recursive: true, force: true }).catch(() => {});
});

test("symlinks inside assets are listed like normal files", async () => {
  const { project } = await makeProject();
  await writeFile(path.join(project, "assets", "real.png"), "x");
  let created = true;
  try {
    await symlink(
      path.join(project, "assets", "real.png"),
      path.join(project, "assets", "alias.png"),
      "file"
    );
  } catch {
    created = false;
  }
  const { files } = await listAssets(project);
  assert.ok(files.some((f) => f.path === "assets/real.png"));
  if (created) assert.ok(files.some((f) => f.path === "assets/alias.png"));
});

test("subdir within assets lists only that subtree", async () => {
  const { project } = await makeProject();
  await mkdir(path.join(project, "assets", "logos"), { recursive: true });
  await writeFile(path.join(project, "assets", "top.png"), "x");
  await writeFile(path.join(project, "assets", "logos", "sub.png"), "x");
  const { files } = await listAssets(project, "logos");
  assert.deepEqual(files.map((f) => f.path), ["assets/logos/sub.png"]);
});
