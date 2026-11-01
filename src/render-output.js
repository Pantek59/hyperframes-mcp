/**
 * render-output.js — unguessable render output paths.
 *
 * The public files route has no login (path obscurity is the only protection),
 * so the render filename must not be guessable. The CLI resolves `-o` as-is
 * against the job cwd (the project dir), so a model-supplied `output` such as
 * "../../x" would escape renders/ — and an absolute path would escape the
 * workspace entirely (the container runs as root). We therefore always pass a
 * safe, randomised output:
 *
 *   renders/<32 hex chars>-<readable-name><ext>
 *
 * - The 128-bit random token makes the public URL unguessable.
 * - The caller's requested name survives as a sanitised, readable suffix.
 * - png-sequence takes a DIRECTORY as `-o` (the CLI writes flat PNG frames
 *   into it), so it gets `renders/<token>-<name>` with no extension.
 *
 * Env:
 *   HF_RANDOMIZE_OUTPUT  set to false/0/no/off to restore legacy behaviour:
 *   `-o` passed through as-is, and default CLI naming (`renders/<name>_
 *   <timestamp>.mp4`) when `-o` is omitted. Legacy mode does NOT sanitise:
 *   use it only for local development.
 */
import crypto from "node:crypto";
import path from "node:path";

const FORMAT_EXTS = { mp4: ".mp4", webm: ".webm", mov: ".mov", gif: ".gif" };
const KNOWN_EXTS = new Set([...Object.values(FORMAT_EXTS), ".png"]);

/** HF_RANDOMIZE_OUTPUT: enabled unless set to false/0/no/off. Default: true. */
export function randomizeOutputEnabled() {
  const v = process.env.HF_RANDOMIZE_OUTPUT;
  if (v === undefined || String(v).trim() === "") return true;
  return !/^(false|0|no|off)$/i.test(String(v).trim());
}

function sanitizeBaseName(output) {
  const raw = String(output ?? "").trim();
  if (!raw) return "";
  const base = path
    .basename(raw)
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w.-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 60)
    .trim();
  return base;
}

function guessExtFromOutput(output) {
  const ext = path.extname(String(output ?? "")).toLowerCase();
  return KNOWN_EXTS.has(ext) ? ext : null;
}

/**
 * Value passed as `-o` to the CLI (or null to omit the flag so the CLI uses
 * its default naming). With randomisation on, the result is always within
 * renders/ of the project (the CLI runs with cwd = project dir).
 */
export function renderOutputArgument({
  output,
  format,
  randomize = randomizeOutputEnabled(),
} = {}) {
  if (!randomize) return output ? String(output) : null;
  const token = crypto.randomBytes(16).toString("hex");
  const base = sanitizeBaseName(output) || "video";
  const fmt = String(format ?? "").trim().toLowerCase();
  const ext =
    fmt === "png-sequence" ? "" : (FORMAT_EXTS[fmt] ?? guessExtFromOutput(output) ?? ".mp4");
  return `renders/${token}-${base}${ext}`;
}
