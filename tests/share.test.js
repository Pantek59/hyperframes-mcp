import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { shareAssetToRenders } from "../src/share.js";

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

async function makeProject(t, file = "assets/voice.wav", content) {
  const workspace = await mkdtemp(path.join(tmpdir(), "hf-share-"));
  const projectDir = path.join(workspace, "project");
  await mkdir(path.join(projectDir, "assets"), { recursive: true });
  await mkdir(path.join(projectDir, "renders"), { recursive: true });
  await writeFile(path.join(projectDir, file), content ?? makeWav());
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return { workspace, projectDir };
}

test("copies an asset into renders with an unguessable name and builds the public url", async (t) => {
  const { workspace, projectDir } = await makeProject(t);
  const shared = await shareAssetToRenders({
    workspace,
    projectDir,
    filename: "voice.wav",
    name: "my voice",
    publicBaseUrl: "https://files.example.net",
  });

  const name = path.basename(shared.path);
  assert.match(name, /^[0-9a-f]{32}-my_voice\.wav$/);
  assert.equal(shared.size, makeWav().length);
  assert.equal(shared.url, `https://files.example.net/files/project/renders/${name}`);
  assert.deepEqual(await readFile(path.join(projectDir, "renders", name)), makeWav());
  // the original asset stays in place
  assert.deepEqual(await readdir(path.join(projectDir, "assets")), ["voice.wav"]);
});

test("derives a readable suffix from the filename when name is omitted", async (t) => {
  const { workspace, projectDir } = await makeProject(t);
  const shared = await shareAssetToRenders({
    workspace,
    projectDir,
    filename: "voice.wav",
    publicBaseUrl: "",
  });
  assert.match(path.basename(shared.path), /^[0-9a-f]{32}-voice\.wav$/);
  assert.equal(shared.url, null); // no PUBLIC_BASE_URL → token-protected /files/ path only
  assert.equal(shared.path, `/files/project/renders/${path.basename(shared.path)}`);
});

test("rejects missing renders dir and assets escaping", async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "hf-share-"));
  const projectDir = path.join(workspace, "project");
  await mkdir(path.join(projectDir, "assets"), { recursive: true });
  await writeFile(path.join(projectDir, "assets", "a.wav"), "x");
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const ctx = { workspace, projectDir };

  await assert.rejects(
    () => shareAssetToRenders({ ...ctx, filename: "a.wav" }),
    /renders directory is missing/
  );
  await assert.rejects(
    () => shareAssetToRenders({ ...ctx, filename: "../index.html" }),
    /assets/
  );
});

test("falls back to the env PUBLIC_BASE_URL when no explicit base is given", async (t) => {
  const { workspace, projectDir } = await makeProject(t);
  process.env.PUBLIC_BASE_URL = "https://env.example.net/";
  try {
    const shared = await shareAssetToRenders({ workspace, projectDir, filename: "voice.wav" });
    assert.match(shared.url, /^https:\/\/env\.example\.net\/files\/project\/renders\/[0-9a-f]{32}-voice\.wav$/);
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
});
