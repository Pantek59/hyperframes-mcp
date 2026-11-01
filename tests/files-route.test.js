import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleFiles, parsePublicPrefixes } from "../src/files.js";

async function startServer({ prefixes = null } = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), "hf-files-"));
  const server = http.createServer(async (req, res) => {
    if (!(await handleFiles(req, res, { workspace, prefixes }))) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not this route");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = () => new Promise((r) => server.close(r));
  return { workspace, base, stop };
}

test("serves a file with correct content-type, nosniff and accept-ranges", async () => {
  const { workspace, base, stop } = await startServer();
  try {
    await mkdir(path.join(workspace, "proj", "renders"), { recursive: true });
    await writeFile(path.join(workspace, "proj", "renders", "a.mp4"), Buffer.alloc(100, 7));
    const res = await fetch(`${base}/files/proj/renders/a.mp4`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal((await res.arrayBuffer()).byteLength, 100);
  } finally {
    await stop();
  }
});

test("unknown extensions get application/octet-stream", async () => {
  const { workspace, base, stop } = await startServer();
  try {
    await writeFile(path.join(workspace, "weird.xyz"), "x");
    const res = await fetch(`${base}/files/weird.xyz`);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
  } finally {
    await stop();
  }
});

test("script-capable types are forced to attachment", async () => {
  const { workspace, base, stop } = await startServer();
  try {
    for (const name of ["page.html", "img.svg", "script.js"]) {
      const dir = path.join(workspace, "proj", "renders");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, name), "x");
      const res = await fetch(`${base}/files/proj/renders/${name}`);
      assert.equal(res.headers.get("content-disposition"), "attachment", name);
      await res.body.cancel();
    }
  } finally {
    await stop();
  }
});

test("no directory listing: root and directories are 404", async () => {
  const { workspace, base, stop } = await startServer();
  try {
    await mkdir(path.join(workspace, "proj", "renders"), { recursive: true });
    assert.equal((await fetch(`${base}/files`)).status, 404);
    assert.equal((await fetch(`${base}/files/`)).status, 404);
    assert.equal((await fetch(`${base}/files/proj`)).status, 404);
    assert.equal((await fetch(`${base}/files/proj/renders`)).status, 404);
  } finally {
    await stop();
  }
});

test("path traversal attempts fail (raw, encoded, double-encoded)", async () => {
  const { base, stop } = await startServer();
  const OUTSIDE = await mkdtemp(path.join(tmpdir(), "hf-outside-"));
  await writeFile(path.join(OUTSIDE, "passwd"), "root:x");
  try {
    // Raw dot segments: fetch() normalises them away, so use a socket client.
    const u = new URL(base);
    const rawStatus = await new Promise((resolve, reject) => {
      const rq = http.request(
        { host: u.hostname, port: u.port, path: `/files/../${path.basename(OUTSIDE)}/passwd` },
        (r) => {
          r.resume();
          r.on("end", () => resolve(r.statusCode));
        }
      );
      rq.on("error", reject);
      rq.end();
    });
    assert.ok([403, 404].includes(rawStatus), `raw traversal got ${rawStatus}`);
    assert.equal((await fetch(`${base}/files/..%2f..%2fetc%2fpasswd`)).status, 403);
    assert.equal((await fetch(`${base}/files/%2e%2e%2fetc%2fpasswd`)).status, 403);
    // double-encoded stays literal: file that does not exist → 404
    assert.equal((await fetch(`${base}/files/..%252f%252fetc%252fpasswd`)).status, 404);
    // malformed % sequences must not crash the route
    assert.equal((await fetch(`${base}/files/%zz`)).status, 404);
  } finally {
    await stop();
  }
});

test("symlinks pointing outside the workspace are refused", async () => {
  const { workspace, base, stop } = await startServer();
  const OUTSIDE = await mkdtemp(path.join(tmpdir(), "hf-outside-"));
  await writeFile(path.join(OUTSIDE, "secret.txt"), "secret");
  try {
    let created = true;
    const target = path.join(OUTSIDE, "secret.txt");
    try {
      await symlink(target, path.join(workspace, "proj", "leak.txt"));
    } catch {
      // On Windows, file symlinks may need privileges; try a junction via link
      created = false;
    }
    if (!created) {
      // directory junction does not require special privileges on Windows
      const dirTarget = OUTSIDE;
      await mkdir(path.join(workspace, "proj"), { recursive: true });
      await symlink(dirTarget, path.join(workspace, "proj", "leakdir"), "junction");
      const res = await fetch(`${base}/files/proj/leakdir/secret.txt`);
      assert.ok([403, 404].includes(res.status));
    } else {
      const res = await fetch(`${base}/files/proj/leak.txt`);
      assert.ok([403, 404].includes(res.status));
    }
  } finally {
    await stop();
  }
});

test("range requests: 206 partial content with content-range", async () => {
  const { workspace, base, stop } = await startServer();
  try {
    await mkdir(path.join(workspace, "p", "renders"), { recursive: true });
    await writeFile(path.join(workspace, "p", "renders", "v.mp4"), "0123456789");
    const r206 = await fetch(`${base}/files/p/renders/v.mp4`, {
      headers: { range: "bytes=2-5" },
    });
    assert.equal(r206.status, 206);
    assert.equal(r206.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(r206.headers.get("content-length"), "4");
    assert.equal(await r206.text(), "2345");

    const suffix = await fetch(`${base}/files/p/renders/v.mp4`, {
      headers: { range: "bytes=-4" },
    });
    assert.equal(await suffix.text(), "6789");

    const open = await fetch(`${base}/files/p/renders/v.mp4`, {
      headers: { range: "bytes=7-" },
    });
    assert.equal(await open.text(), "789");

    const bad = await fetch(`${base}/files/p/renders/v.mp4`, {
      headers: { range: "bytes=9-5" },
    });
    assert.equal(bad.status, 200);

    const tooFar = await fetch(`${base}/files/p/renders/v.mp4`, {
      headers: { range: "bytes=10-" },
    });
    assert.equal(tooFar.status, 416);
    assert.equal(tooFar.headers.get("content-range"), "bytes */10");
  } finally {
    await stop();
  }
});

test("HEAD works like GET without a body", async () => {
  const { workspace, base, stop } = await startServer();
  try {
    await writeFile(path.join(workspace, "f.mp4"), "0123456789");
    const res = await fetch(`${base}/files/f.mp4`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), "10");
    assert.equal(await res.text(), "");
  } finally {
    await stop();
  }
});

test("prefix restriction: renders only when enabled, everything when not", async () => {
  const { workspace, base, stop } = await startServer({
    prefixes: parsePublicPrefixes("renders"),
  });
  try {
    await mkdir(path.join(workspace, "p", "renders"), { recursive: true });
    await mkdir(path.join(workspace, "p", "snapshots"), { recursive: true });
    await writeFile(path.join(workspace, "p", "renders", "a.mp4"), "x");
    await writeFile(path.join(workspace, "p", "snapshots", "b.png"), "x");
    assert.equal((await fetch(`${base}/files/p/renders/a.mp4`)).status, 200);
    assert.equal((await fetch(`${base}/files/p/snapshots/b.png`)).status, 404);
    assert.equal((await fetch(`${base}/files/p/index.html`)).status, 404);
  } finally {
    await stop();
  }
});

test("prefix restriction disabled by default (snapshots also served)", async () => {
  const { workspace, base, stop } = await startServer();
  try {
    await mkdir(path.join(workspace, "p", "snapshots"), { recursive: true });
    await writeFile(path.join(workspace, "p", "snapshots", "b.png"), "x");
    assert.equal((await fetch(`${base}/files/p/snapshots/b.png`)).status, 200);
  } finally {
    await stop();
  }
});

test("parsePublicPrefixes: off by default, CSV supported", () => {
  assert.equal(parsePublicPrefixes(undefined), null);
  assert.equal(parsePublicPrefixes(""), null);
  assert.deepEqual(parsePublicPrefixes("1"), ["renders"]);
  assert.deepEqual(parsePublicPrefixes("true"), ["renders"]);
  assert.deepEqual(parsePublicPrefixes("renders"), ["renders"]);
  assert.deepEqual(parsePublicPrefixes("renders, /shots/"), ["renders", "shots"]);
});
