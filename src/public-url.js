/**
 * public-url.js — public download URLs for rendered artifacts.
 *
 * When PUBLIC_BASE_URL is set (e.g. "https://files.example.net" — the only
 * host the reverse proxy exposes), job results attach a `url` field to every
 * file entry under a project's renders/, so the agent never has to assemble
 * URLs from instructions. Snapshots, sources and assets are never public and
 * never get a `url`. Without PUBLIC_BASE_URL the entries are unchanged.
 *
 * Entries built by jobFiles() look like "/files/<project>/renders/<file>" —
 * the /files/ route is rooted at the HF_WORKSPACE, hence the full relative path.
 * Every path segment is percent-encoded; a single decodeURIComponent on the
 * /files/ route round-trips non-ASCII names correctly (only one decode happens
 * per request, so literal '%' in a name cannot introduce directory separators).
 */
export function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
}

const RENDERS_RE = /^[^/]+\/renders\/(.+)$/;

/** Map jobFiles() entries: renders/ files become { path, url }, others unchanged. */
export function withPublicUrls(entries) {
  const base = publicBaseUrl();
  if (!Array.isArray(entries) || !base) return entries;
  return entries.map((entry) => {
    if (typeof entry !== "string" || !entry.startsWith("/files/")) return entry;
    const wsRel = entry.slice("/files/".length);
    if (!RENDERS_RE.test(wsRel)) return entry;
    const encoded = wsRel.split("/").map(encodeURIComponent).join("/");
    return { path: entry, url: `${base}/files/${encoded}` };
  });
}
