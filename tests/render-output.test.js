import test from "node:test";
import assert from "node:assert/strict";
import { renderOutputArgument, randomizeOutputEnabled } from "../src/render-output.js";

test("default: always under renders/ with a random token and .mp4 ext", () => {
  assert.match(renderOutputArgument({}), /^renders\/[0-9a-f]{32}-video\.mp4$/);
});

test("two renders with the same requested name get different filenames", () => {
  const a = renderOutputArgument({ output: "intro" });
  const b = renderOutputArgument({ output: "intro" });
  assert.notEqual(a, b);
  assert.match(a, /intro\.mp4$/);
  assert.match(b, /intro\.mp4$/);
});

test("traversal in output stays inside renders/ and keeps a readable name", () => {
  assert.match(
    renderOutputArgument({ output: "../../evil.mp4" }),
    /^renders\/[0-9a-f]{32}-evil\.mp4$/
  );
});

test("absolute paths in output are flattened to the basename", () => {
  assert.match(
    renderOutputArgument({ output: "/tmp/secret/video.mp4" }),
    /^renders\/[0-9a-f]{32}-video\.mp4$/
  );
});

test("format selects the extension", () => {
  assert.match(renderOutputArgument({ format: "gif" }), /\.gif$/);
  assert.match(renderOutputArgument({ format: "webm", output: "clip" }), /\.webm$/);
  assert.match(renderOutputArgument({ format: "mov", output: "spot.mp4" }), /\.mov$/);
});

test("png-sequence yields an extensionless directory name", () => {
  assert.match(
    renderOutputArgument({ format: "png-sequence", output: "frames/" }),
    /^renders\/[0-9a-f]{32}-frames$/
  );
});

test("unusual characters are sanitised (kept readable)", () => {
  assert.match(
    renderOutputArgument({ output: "Mi Vídeo (final)!?.mp4" }),
    /^renders\/[0-9a-f]{32}-Mi_V_deo__final___\.mp4$/
  );
});

test("base name is capped at 60 chars", () => {
  const r = renderOutputArgument({ output: "n".repeat(70) });
  assert.equal(r.length, "renders/".length + 32 + 1 + 60 + ".mp4".length);
});

test("dot-only names fall back to 'video'", () => {
  assert.match(renderOutputArgument({ output: ".." }), /-video\.mp4$/);
});

test("randomize flag: default on, false-ish values disable", () => {
  const prev = process.env.HF_RANDOMIZE_OUTPUT;
  try {
    delete process.env.HF_RANDOMIZE_OUTPUT;
    assert.equal(randomizeOutputEnabled(), true);
    process.env.HF_RANDOMIZE_OUTPUT = "1";
    assert.equal(randomizeOutputEnabled(), true);
    process.env.HF_RANDOMIZE_OUTPUT = "FALSE";
    assert.equal(randomizeOutputEnabled(), false);
    process.env.HF_RANDOMIZE_OUTPUT = "0";
    assert.equal(randomizeOutputEnabled(), false);
    process.env.HF_RANDOMIZE_OUTPUT = "no";
    assert.equal(randomizeOutputEnabled(), false);
    process.env.HF_RANDOMIZE_OUTPUT = "off";
    assert.equal(randomizeOutputEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.HF_RANDOMIZE_OUTPUT;
    else process.env.HF_RANDOMIZE_OUTPUT = prev;
  }
});

test("legacy mode passes output through as-is and omits -o when unset", () => {
  const prev = process.env.HF_RANDOMIZE_OUTPUT;
  try {
    process.env.HF_RANDOMIZE_OUTPUT = "false";
    assert.equal(renderOutputArgument({ output: "custom/take 2.mp4" }), "custom/take 2.mp4");
    assert.equal(renderOutputArgument({}), null);
  } finally {
    if (prev === undefined) delete process.env.HF_RANDOMIZE_OUTPUT;
    else process.env.HF_RANDOMIZE_OUTPUT = prev;
  }
});
