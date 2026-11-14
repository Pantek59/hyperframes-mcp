/**
 * comfyui.js — minimal ComfyUI REST client used by the Fish Audio TTS runner
 * (and the comfyui_status health tool).
 *
 * Scope: origin-validated base URL, submit an API-format workflow via
 * POST /prompt, poll GET /history/{prompt_id}, download outputs via GET /view,
 * upload reference files via POST /upload/image (works for audio in the input
 * dir), and read-only probes of /system_stats and /queue. Upstream error
 * bodies are never surfaced — errors carry only HTTP status counts/summary.
 */
import { randomUUID } from "node:crypto";

const MAX_JSON_BYTES = 4 * 1024 * 1024;

export function getComfyConfig(env = process.env) {
  return {
    baseUrl: String(env.COMFYUI_BASE_URL || "").trim(),
    apiKey: String(env.COMFYUI_API_KEY || "").trim(),
  };
}

/** Fetch/network failures lose details in Node; surface the cause code. */
export function describeFetchError(error) {
  const message = String(error?.message || error || "request failed");
  const code = error?.cause?.code || error?.code;
  return code ? `${message} (${code})` : message;
}

export function createComfyClient({ baseUrl, apiKey, fetchImpl = globalThis.fetch } = {}) {
  baseUrl = String(baseUrl || "").trim();
  if (!baseUrl) throw new Error("ComfyUI is not configured: set COMFYUI_BASE_URL");
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("COMFYUI_BASE_URL must be a valid HTTP(S) base URL");
  }
  if (!new Set(["http:", "https:"]).has(base.protocol) || base.username || base.password ||
      base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) {
    throw new Error("COMFYUI_BASE_URL must be an HTTP(S) origin without credentials or a path");
  }
  apiKey = String(apiKey || "").trim();
  if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch");

  const endpoint = (pathname) => new URL(pathname, base);
  const headers = () => {
    const out = {};
    if (apiKey) out.authorization = `Bearer ${apiKey}`;
    return out;
  };

  async function readBoundedResponse(response, maxBytes) {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`ComfyUI response exceeds the ${maxBytes}-byte limit`);
    }
    if (!response.body) throw new Error("ComfyUI returned an empty response");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error(`ComfyUI response exceeds the ${maxBytes}-byte limit`);
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
  }

  async function readJson(response, maxBytes = MAX_JSON_BYTES) {
    const buffer = await readBoundedResponse(response, maxBytes);
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new Error("ComfyUI returned malformed JSON");
    }
    return parsed;
  }

  function rejectStatus(response, what) {
    return `ComfyUI ${what} returned HTTP ${response.status}`;
  }

  return {
    baseUrl,
    endpoint,

    /** GET /system_stats — parsed JSON (version, GPU info) or throws. */
    async systemStats(signal) {
      const response = await fetchImpl(endpoint("/system_stats"), {
        headers: { accept: "application/json", ...headers() },
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(rejectStatus(response, "status request"));
      }
      return readJson(response);
    },

    /** GET /queue — { running, pending } counts only. */
    async queueState(signal) {
      const response = await fetchImpl(endpoint("/queue"), {
        headers: { accept: "application/json", ...headers() },
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(rejectStatus(response, "queue request"));
      }
      const data = await readJson(response);
      return {
        running: Array.isArray(data?.running) ? data.running.length : 0,
        pending: Array.isArray(data?.pending) ? data.pending.length : 0,
      };
    },

    /**
     * POST /upload/image — publishes a reference file into ComfyUI's input
     * dir (overwrite=false so the server numbers duplicates) and returns the
     * echoed file name to use in the workflow.
     */
    async uploadFile({ buffer, filename, signal }) {
      const safeName = String(filename)
        .split(/[\\/]+/).pop()
        .replace(/[\x00-\x1f"\\]/g, "_")
        .trim() || "reference.bin";
      const boundary = `hfcm${randomUUID().replaceAll("-", "")}`;
      const head = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="type"\r\n\r\ninput\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="overwrite"\r\n\r\nfalse\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="image"; filename="${safeName}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
        "utf8"
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
      const body = Buffer.concat([head, buffer, tail]);
      const response = await fetchImpl(endpoint("/upload/image"), {
        method: "POST",
        headers: { accept: "application/json", ...headers(), "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": body.length },
        body,
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(rejectStatus(response, "reference upload"));
      }
      const data = await readJson(response, MAX_JSON_BYTES);
      const name = typeof data?.name === "string" ? data.name.trim() : "";
      if (!name) throw new Error("ComfyUI did not return an uploaded file name");
      return { filename: name };
    },

    /** POST /prompt — submit an API-format workflow; returns the prompt id. */
    async submitWorkflow({ workflow, signal }) {
      const response = await fetchImpl(endpoint("/prompt"), {
        method: "POST",
        headers: { accept: "application/json", ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`ComfyUI rejected the workflow (HTTP ${response.status})`);
      }
      const data = await readJson(response);
      const nodeErrors = data?.node_errors && typeof data.node_errors === "object"
        ? Object.keys(data.node_errors).length
        : 0;
      if (nodeErrors > 0) {
        throw new Error(`ComfyUI rejected the workflow (${nodeErrors} node error${nodeErrors === 1 ? "" : "s"})`);
      }
      if (typeof data?.prompt_id !== "string" || !data.prompt_id) {
        throw new Error("ComfyUI did not return a prompt_id");
      }
      return data.prompt_id;
    },

    /** GET /history/{prompt_id} — the workflow entry, or null until known. */
    async history(promptId, signal) {
      const response = await fetchImpl(endpoint(`/history/${encodeURIComponent(promptId)}`), {
        headers: { accept: "application/json", ...headers() },
        signal,
        redirect: "error",
      });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(rejectStatus(response, "history request"));
      }
      const data = await readJson(response);
      const entry = data?.[promptId];
      return entry && typeof entry === "object" ? entry : null;
    },

    /** Poll /history until the workflow completes; rejects on execution error. */
    async waitForCompletion({ promptId, signal, pollMs = 1000 } = {}) {
      const sleep = () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, pollMs);
        function onAbort() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(signal.reason || new Error("Job canceled"));
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      for (;;) {
        if (signal?.aborted) throw signal.reason || new Error("Job canceled");
        const entry = await this.history(promptId, signal);
        if (entry) {
          const status = entry.status || {};
          if (status.status_str === "error") {
            throw new Error("ComfyUI reported an execution error for the workflow");
          }
          if (status.completed || status.status_str === "success") return entry.outputs || {};
        }
        await sleep();
      }
    },

    /** GET /view — download an output artifact, capped at maxBytes. */
    async fetchOutput({ filename, subfolder, type, maxBytes, signal }) {
      const url = new URL("/view", base);
      url.searchParams.set("filename", String(filename || ""));
      url.searchParams.set("subfolder", String(subfolder || ""));
      url.searchParams.set("type", String(type || "output"));
      const response = await fetchImpl(url, {
        headers: headers(),
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(rejectStatus(response, "output download"));
      }
      return readBoundedResponse(response, maxBytes);
    },
  };
}
