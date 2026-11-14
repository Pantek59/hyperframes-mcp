import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describeFetchError, createComfyClient } from "../src/comfyui.js";

test("validates the ComfyUI base URL with actionable errors", () => {
  assert.throws(() => createComfyClient({}), /COMFYUI_BASE_URL/);
  assert.throws(() => createComfyClient({ baseUrl: "not a url" }), /valid HTTP\(S\) base URL/);
  assert.throws(() => createComfyClient({ baseUrl: "http://comfy:8188/sub" }), /origin without credentials or a path/);
  assert.throws(
    () => createComfyClient({ baseUrl: "http://user:pass@comfy:8188" }),
    /origin without credentials or a path/
  );
});

test("probes system stats and queue state", async (t) => {
  const service = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/system_stats") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({
        system: { comfyui_version: "0.3.40", os: "nt" },
        devices: [{ name: "RTX", type: "cuda", vram_total: 24, vram_free: 12 }],
      }));
    }
    if (request.method === "GET" && url.pathname === "/queue") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ running: [{}] , pending: [] }));
    }
    if (request.method === "GET" && url.pathname === "/history/unknown-prompt") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end("{}");
    }
    response.writeHead(404);
    response.end("{}");
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => service.close((error) => error ? reject(error) : resolve())));

  const client = createComfyClient({ baseUrl: `http://127.0.0.1:${service.address().port}` });
  const stats = await client.systemStats();
  assert.equal(stats.system.comfyui_version, "0.3.40");
  assert.deepEqual(await client.queueState(), { running: 1, pending: 0 });
  const entry = await client.history("unknown-prompt");
  assert.equal(entry, null);
});

test("rejects non-OK probes, missing upload names and malformed JSON", async (t) => {
  const service = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/system_stats") {
      response.writeHead(502, { "content-type": "text/plain" });
      return response.end("proxy error");
    }
    if (request.method === "POST" && url.pathname === "/upload/image") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end("{}");
    }
    response.writeHead(200, { "content-type": "application/json" });
    return response.end("definitely not json");
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => service.close((error) => error ? reject(error) : resolve())));

  const client = createComfyClient({ baseUrl: `http://127.0.0.1:${service.address().port}` });
  await assert.rejects(() => client.systemStats(), /HTTP 502/);
  await assert.rejects(
    () => client.uploadFile({ buffer: Buffer.from("x"), filename: "ref.wav" }),
    /did not return an uploaded file name/
  );
  await assert.rejects(() => client.queueState(), /malformed JSON/);
});

test("describeFetchError surfaces the underlying cause code", () => {
  const error = new Error("fetch failed");
  error.cause = { code: "ECONNREFUSED" };
  assert.equal(describeFetchError(error), "fetch failed (ECONNREFUSED)");
  assert.equal(describeFetchError(new Error("boom")), "boom");
});
