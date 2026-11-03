import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveAssetInput,
  resolveAssetOutput,
  createPrivateTempFile,
  publishNoReplace,
  cleanupPublishedFile,
  cleanupTempFile,
} from "../src/asset-ops.js";
import { listAssets } from "../src/assets.js";

async function makeProject() {
  const workspace = await mkdtemp(path.join(tmpdir(), "hf-assets-"));
  const projectDir = path.join(workspace, "project");
  await mkdir(path.join(projectDir, "assets", "audio"), { recursive: true });
  await writeFile(path.join(projectDir, "assets", "audio", "voice.txt"), "Hello.");
  return { workspace, projectDir };
}

test("resolves a nested asset and creates a project-relative unique output name", async () => {
  const { workspace, projectDir } = await makeProject();
  const input = await resolveAssetInput({ workspace, projectDir, filename: "audio/voice.txt" });
  const output = await resolveAssetOutput({
    workspace,
    projectDir,
    filename: "audio/voice.txt",
    jobId: "job-123",
    extension: ".wav",
  });

  assert.equal(path.basename(input.path), "voice.txt");
  assert.equal(output.inputPath, input.path);
  assert.equal(output.artifactPath, "assets/audio/voice.job-123.wav");
  await rm(workspace, { recursive: true, force: true });
});

test("keeps logical assets paths through safe root and directory symlinks", async (t) => {
  const { workspace, projectDir } = await makeProject();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const storage = path.join(projectDir, "storage");
  await rename(path.join(projectDir, "assets"), storage);
  await symlink(storage, path.join(projectDir, "assets"), "dir");
  await symlink(path.join(storage, "audio"), path.join(storage, "alias"), "dir");

  const output = await resolveAssetOutput({
    workspace,
    projectDir,
    filename: "alias/voice.txt",
    jobId: "job-123",
    extension: ".wav",
  });
  assert.equal(output.artifactPath, "assets/alias/voice.job-123.wav");
  assert.equal(output.parent, path.join(storage, "audio"));
  const temporary = await createPrivateTempFile(output.parent, "job-123");
  await temporary.handle.writeFile("audio");
  await temporary.handle.close();
  await publishNoReplace(temporary.path, output.path, output.parent);
  const listing = await listAssets(projectDir, "alias");
  assert.ok(listing.files.some((file) => file.path === output.artifactPath));
});

test("writes next to a safe file alias, not next to its target", async (t) => {
  const { workspace, projectDir } = await makeProject();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const assets = path.join(projectDir, "assets");
  await mkdir(path.join(assets, "aliases"));
  await symlink(path.join(assets, "audio", "voice.txt"), path.join(assets, "aliases", "narration.txt"));

  const output = await resolveAssetOutput({
    workspace,
    projectDir,
    filename: "aliases/narration.txt",
    jobId: "job-123",
    extension: ".wav",
  });
  assert.equal(output.artifactPath, "assets/aliases/narration.job-123.wav");
  assert.equal(output.parent, path.join(assets, "aliases"));
});

test("rejects traversal, absolute paths, non-files, and symlink escapes", async () => {
  const { workspace, projectDir } = await makeProject();
  const outside = path.join(workspace, "outside.txt");
  await writeFile(outside, "secret");

  await assert.rejects(() => resolveAssetInput({ workspace, projectDir, filename: "../outside.txt" }));
  await assert.rejects(() => resolveAssetInput({ workspace, projectDir, filename: outside }));
  await assert.rejects(() => resolveAssetInput({ workspace, projectDir, filename: "audio" }));
  try {
    await symlink(outside, path.join(projectDir, "assets", "audio", "escape.txt"));
    await assert.rejects(() => resolveAssetInput({ workspace, projectDir, filename: "audio/escape.txt" }));
    const outsideDir = path.join(workspace, "outside-dir");
    await mkdir(outsideDir);
    await symlink(path.join(projectDir, "assets", "audio", "voice.txt"), path.join(outsideDir, "inside.txt"));
    await symlink(outsideDir, path.join(projectDir, "assets", "escape-dir"), "dir");
    await assert.rejects(() => resolveAssetOutput({
      workspace,
      projectDir,
      filename: "escape-dir/inside.txt",
      jobId: "job-123",
      extension: ".wav",
    }));
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
  }
  await rm(workspace, { recursive: true, force: true });
});

test("publishes a private temporary file atomically without overwriting", async () => {
  const { workspace, projectDir } = await makeProject();
  const output = await resolveAssetOutput({
    workspace,
    projectDir,
    filename: "audio/voice.txt",
    jobId: "job-456",
    extension: ".wav",
  });
  const temporary = await createPrivateTempFile(output.parent, "job-456");
  await temporary.handle.writeFile(Buffer.from("wav data"));
  const identity = await temporary.handle.stat();
  await temporary.handle.close();
  await publishNoReplace(temporary.path, output.path, output.parent, identity);

  assert.equal(await readFile(output.path, "utf8"), "wav data");
  const collision = await createPrivateTempFile(output.parent, "job-456");
  await collision.handle.writeFile(Buffer.from("replacement"));
  const collisionIdentity = await collision.handle.stat();
  await collision.handle.close();
  await assert.rejects(() => publishNoReplace(collision.path, path.join(output.parent, "other.wav"), output.parent, identity), /changed/);
  await assert.rejects(() => publishNoReplace(collision.path, output.path, output.parent, collisionIdentity), { code: "EEXIST" });
  await cleanupTempFile(collision.path);
  assert.equal(await cleanupPublishedFile(output.path, output.parent, collisionIdentity), false);
  assert.equal(await readFile(output.path, "utf8"), "wav data");
  assert.equal(await cleanupPublishedFile(output.path, output.parent, identity), true);
  await assert.rejects(() => readFile(output.path));
  await rm(workspace, { recursive: true, force: true });
});