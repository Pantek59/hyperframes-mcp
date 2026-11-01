/**
 * files.js — GET/HEAD /files/<path-relative-to-workspace>, hardening pass.
 *
 * Semantics kept compatible with the previous inline handler (auth is
 * enforced by the caller; 403/404 for escapes), plus defence in depth:
 * - realpath check: symlinks resolving outside the workspace are refused;
 * - decodeURIComponent guarded so malformed %-sequences cannot crash the server;
 * - correct Content-Type per extension + X-Content-Type-Options: nosniff;
 * - Accept-Ranges and single-Range (206) support so videos can seek;
 * - script-capable types (html, svg, js, …) get Content-Disposition:
 *   attachment — user uploads live in the same workspace;
 * - no directory listings (404);
 * - optional HF_FILES_PUBLIC_PREFIX_ONLY restricts the route to
 *   <project>/<prefix>/… paths (see parsePublicPrefixes).
 */
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";

const MIME = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  gif: "image/gif",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  aac: "audio/aac",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  css: "text/css",
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  xhtml: "text/html",
  svg: "image/svg+xml",
  xml: "application/xml",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
};

// Content the browser can execute inline (or deface with) must download
// instead of rendering, since user uploads share this workspace.
const ATTACHMENT_TYPES = new Set([
  "html",
  "htm",
  "xhtml",
  "svg",
  "xml",
  "js",
  "mjs",
  "cjs",
  "swf",
]);

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** HF_FILES_PUBLIC_PREFIX_ONLY (default off). "1|true|yes|on" → ["renders"]; otherwise CSV list. */
export function parsePublicPrefixes(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  if (/^(1|true|yes|on)$/i.test(v)) return ["renders"];
  const list = v
    .split(",")
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return list.length ? list : null;
}

/**
 * RFC 7233 single-byte-range parse. Returns null (serve full 200) for absent,
 * multi-range or invalid ranges, { unsatisfiable: true } when the start is
 * past the end of the file (→ 416), or { start, end } as a valid byte range.
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    const n = parseInt(m[2], 10);
    if (n === 0) return { unsatisfiable: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size) return { unsatisfiable: true };
  if (end < start) return null;
  return { start, end };
}

/** Handle the /files/ route; false means "not this route" (caller keeps routing). */
export async function handleFiles(req, res, { workspace, prefixes = null } = {}) {
  const method = req.method || "GET";
  if (method !== "GET" && method !== "HEAD") return false;
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    return false;
  }
  if (!pathname.startsWith("/files/")) return false;

  const NOSNIFF = { "x-content-type-options": "nosniff" };
  const plain = (code, body = "", extra = {}) => {
    res.writeHead(code, { "content-type": "text/plain; charset=utf-8", ...NOSNIFF, ...extra });
    res.end(method === "HEAD" ? undefined : body);
    return true; // route claimed — callers must never respond twice
  };

  let relPath;
  try {
    relPath = decodeURIComponent(pathname.slice("/files/".length));
  } catch {
    return plain(404, "not found");
  }

  const fp = path.resolve(workspace, relPath);
  if (fp !== workspace && !fp.startsWith(workspace + path.sep)) return plain(403, "forbidden");

  // Optional restriction to prefix subfolders (e.g. <project>/renders/…).
  if (prefixes && prefixes.length) {
    const wsNorm = path.relative(workspace, fp).split(path.sep).join("/");
    const re = new RegExp(
      `^[^/]+/(?:${prefixes.map((p) => p.replace(RE_ESCAPE, "\\$&")).join("|")})/.`
    );
    if (!re.test(wsNorm)) return plain(404, "not found");
  }

  // Symlinks must not escape the workspace.
  let real;
  try {
    real = await fs.realpath(fp);
  } catch {
    return plain(404, "not found");
  }
  if (real !== workspace && !real.startsWith(workspace + path.sep)) return plain(403, "forbidden");

  let st;
  try {
    st = await fs.stat(real);
  } catch {
    return plain(404, "not found");
  }
  if (!st.isFile()) return plain(404, "not found"); // no directory listings

  const ext = path.extname(real).toLowerCase().slice(1);
  const headers = {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": st.size,
    "accept-ranges": "bytes",
  };
  if (ATTACHMENT_TYPES.has(ext)) headers["content-disposition"] = "attachment";

  const range = parseRange(req.headers.range, st.size);
  if (range && range.unsatisfiable) {
    return plain(416, "range not satisfiable", { "content-range": `bytes */${st.size}` });
  }
  if (range) {
    res.writeHead(206, {
      ...NOSNIFF,
      ...headers,
      "content-range": `bytes ${range.start}-${range.end}/${st.size}`,
      "content-length": range.end - range.start + 1,
    });
    if (method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(real, { start: range.start, end: range.end })
      .on("error", () => res.destroy())
      .pipe(res);
    return true;
  }

  res.writeHead(200, { ...NOSNIFF, ...headers });
  if (method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(real)
    .on("error", () => res.destroy())
    .pipe(res);
  return true;
}
