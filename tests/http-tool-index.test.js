import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

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

test("HTTP tool index advertises Higgs Audio TTS", { timeout: 15000 }, async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "hf-http-index-"));
  const port = await unusedPort();
  const projectAssets = path.join(workspace, "project", "assets", "narration");
  await mkdir(projectAssets, { recursive: true });
  await writeFile(path.join(projectAssets, "script.txt"), "Read this aloud.");
  const serviceRequests = [];
  const service = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    serviceRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "audio/wav" });
    response.end(makeWav());
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  const higgsUrl = `http://127.0.0.1:${service.address().port}`;
  t.after(() => new Promise((resolve, reject) => service.close((error) => error ? reject(error) : resolve())));
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      PORT: String(port),
      HF_WORKSPACE: workspace,
      HF_JOBS_DIR: path.join(workspace, "jobs"),
      MCP_AUTH_TOKEN: "http-index-test-token",
      HIGGS_AUDIO_BASE_URL: higgsUrl,
      HIGGS_AUDIO_MODEL: "mcp-test-model",
      HIGGS_AUDIO_VOICE: "mcp-test-voice",
      HIGGS_AUDIO_API_KEY: "",
      HIGGS_AUDIO_TIMEOUT_MS: "5000",
      HF_WAIT_MAX_MS: "5000",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      let timeout;
      const stopped = await Promise.race([
        exit.then(() => true),
        new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 1000); }),
      ]);
      clearTimeout(timeout);
      if (!stopped) {
        child.kill("SIGKILL");
        await exit;
      }
    }
    await rm(workspace, { recursive: true, force: true });
  });

  const url = `http://127.0.0.1:${port}`;
  let response;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`MCP server exited before listening (code ${child.exitCode})`);
    try {
      response = await fetch(`${url}/`, {
        headers: { authorization: "Bearer http-index-test-token" },
        signal: AbortSignal.timeout(250),
      });
      break;
    } catch {
      await delay(50);
    }
  }
  assert.ok(response, "HTTP MCP server should start");
  assert.equal(response.status, 200);
  const index = await response.json();
  assert.ok(index.tools.includes("higgs_audio_tts"));
  assert.ok(index.tools.includes("whisperx_transcribe"));

  const mcp = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer http-index-test-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(mcp.status, 200);
  const toolResponse = await mcp.json();
  assert.ok(toolResponse.result.tools.some((tool) => tool.name === "higgs_audio_tts"));
  assert.ok(toolResponse.result.tools.some((tool) => tool.name === "whisperx_transcribe"));

  const callTool = async (args) => {
    const result = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer http-index-test-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "higgs_audio_tts", arguments: args },
      }),
    });
    assert.equal(result.status, 200);
    return result.json();
  };

  const synchronous = await callTool({
    project: "project",
    filename: "narration/script.txt",
    wait: true,
    timeout_ms: 5000,
  });
  const synchronousDetail = JSON.parse(synchronous.result.content[0].text);
  assert.equal(synchronousDetail.status, "succeeded");
  assert.match(synchronousDetail.artifacts[0], /^assets\/narration\/script\..+\.wav$/);

  const queued = await callTool({ project: "project", filename: "narration/script.txt" });
  const queuedSummary = JSON.parse(queued.result.content[0].text);
  assert.ok(["queued", "running"].includes(queuedSummary.status));
  let queuedDetail;
  for (let attempt = 0; attempt < 80; attempt++) {
    const status = await fetch(`${url}/jobs/${queuedSummary.job_id}`, {
      headers: { authorization: "Bearer http-index-test-token" },
    });
    queuedDetail = await status.json();
    if (queuedDetail.status === "succeeded" || queuedDetail.status === "failed") break;
    await delay(25);
  }
  assert.equal(queuedDetail.status, "succeeded");
  assert.match(queuedDetail.artifacts[0], /^assets\/narration\/script\..+\.wav$/);
  assert.equal(serviceRequests.length, 2);
  assert.deepEqual(serviceRequests[0], {
    model: "mcp-test-model",
    input: "Read this aloud.",
    voice: "mcp-test-voice",
    response_format: "wav",
  });
});