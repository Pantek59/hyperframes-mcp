import test from "node:test";
import assert from "node:assert/strict";
import { withPublicUrls, publicBaseUrl } from "../src/public-url.js";

const PREV = process.env.PUBLIC_BASE_URL;

function setBase(v) {
  if (v === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = v;
}

test("no PUBLIC_BASE_URL: entries are returned unchanged", () => {
  setBase(undefined);
  const entries = ["/files/proj/renders/a.mp4", "/files/proj/snapshots/f.png"];
  assert.deepEqual(withPublicUrls(entries), entries);
});

test("renders/ entries get a URL rooted at the workspace with encoded segments", () => {
  setBase("https://files.example.net");
  const out = withPublicUrls([
    "/files/proj/renders/a b & x=1 ünïcode.mp4",
    "/files/proj/renders/frames/f_000001.png",
  ]);
  assert.deepEqual(out[0], {
    path: "/files/proj/renders/a b & x=1 ünïcode.mp4",
    url: "https://files.example.net/files/proj/renders/a%20b%20%26%20x%3D1%20%C3%BCn%C3%AFcode.mp4",
  });
  assert.equal(out[1].url, "https://files.example.net/files/proj/renders/frames/f_000001.png");
});

test("snapshots and anything outside renders/ NEVER get a url", () => {
  setBase("https://files.example.net");
  const in2 = [
    "/files/proj/snapshots/shot_1.png",
    "/files/proj/index.html",
    "/files/proj/assets/logo.png",
    "/files/proj/renders",
    "not-a-file-entry",
  ];
  const out = withPublicUrls(in2);
  for (let i = 0; i < in2.length; i++) {
    assert.equal(typeof out[i], "string");
    assert.equal(out[i], in2[i]);
  }
});

test("trailing slashes are stripped from PUBLIC_BASE_URL", () => {
  setBase("https://files.example.net///");
  assert.equal(publicBaseUrl(), "https://files.example.net");
  const [entry] = withPublicUrls(["/files/p/renders/v.mp4"]);
  assert.equal(entry.url, "https://files.example.net/files/p/renders/v.mp4");
  setBase(undefined);
});

test("filename with literal % round-trips through one decode", () => {
  setBase("https://files.example.net");
  const [entry] = withPublicUrls(["/files/p/renders/100% done.mp4"]);
  const u = new URL(entry.url);
  assert.equal(decodeURIComponent(u.pathname), "/files/p/renders/100% done.mp4");
  setBase(undefined);
});

test("non-string entries stay untouched", () => {
  setBase("https://files.example.net");
  assert.deepEqual(
    withPublicUrls([{ path: "/files/p/renders/x.mp4" }]),
    [{ path: "/files/p/renders/x.mp4" }]
  );
  setBase(undefined);
});

// restore env for subsequent test files if run in-process
if (PREV === undefined) delete process.env.PUBLIC_BASE_URL;
else process.env.PUBLIC_BASE_URL = PREV;
