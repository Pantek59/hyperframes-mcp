/**
 * assets.js — read-only listing of the files users upload into
 * <project>/assets/ through the external file manager. The agent cannot ask
 * the model to invent them: it queries them here.
 *
 * Safety:
 * - The assets/ directory itself must resolve (realpath) inside the project's
 *   real directory, otherwise it is treated as absent.
 * - `subdir` is resolved with realpath and re-validated; anything escaping
 *   assets/ throws.
 * - Symlinked entries that resolve outside assets/ are skipped; symlinked
 *   directories resolved inside assets/ are listed.
 * - Dotfiles are ignored, recursion stops after MAX_DEPTH directories and the
 *   listing caps at MAX_ENTRIES files (truncated: true).
 *
 * Paths are returned relative to the PROJECT, in exactly the form compositions
 * use: "assets/logo.png" (src="assets/…").
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_ENTRIES = 500;
const MAX_DEPTH = 3;

const EXT_TYPES = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "heic", "heif"],
  audio: ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "aiff", "aif"],
  video: ["mp4", "webm", "mov", "m4v", "avi", "mkv"],
  font: ["ttf", "otf", "woff", "woff2", "ttc"],
};

function typeFor(name) {
  const ext = path.extname(String(name)).toLowerCase().slice(1);
  for (const [type, exts] of Object.entries(EXT_TYPES)) {
    if (exts.includes(ext)) return type;
  }
  return "other";
}

export const ASSETS_MAX_DEPTH = MAX_DEPTH;
export const ASSETS_MAX_ENTRIES = MAX_ENTRIES;

/**
 * Attach the workspace-relative /files/ route to each listing entry so agents
 * can reference (and share_asset can publish) assets unambiguously. Every path
 * segment is percent-encoded; the /files/ route decodes exactly once, so
 * non-ASCII names round-trip and literal '%'/traversal cannot be injected.
 */
export function addFileLinks(files, project) {
  return files.map((entry) => {
    if (!entry || typeof entry.path !== "string") return entry;
    const wsRel = [project, entry.path].map((s) => s.split("/")).flat()
      .filter((seg) => seg && seg !== ".").map(encodeURIComponent).join("/");
    return { ...entry, link: `/files/${wsRel}` };
  });
}

/**
 * List files under <projectDir>/assets/. Returns { files, truncated }; each
 * file is { path: "assets/…", size, modified, type }. Throws for an invalid
 * `subdir` (escaping assets/, or nonexistent). A missing assets/ directory is
 * not an error: it yields an empty list.
 */
export async function listAssets(projectDir, subdir) {
  const projectReal = await fs.realpath(projectDir).catch(() => null);
  const assetsReal = await fs.realpath(path.join(projectDir, "assets")).catch(() => null);
  if (!projectReal || !assetsReal) return { files: [], truncated: false };
  const insideProject = (p) =>
    p === projectReal || p.startsWith(projectReal + path.sep);
  if (!insideProject(assetsReal)) return { files: [], truncated: false };

  let baseReal = assetsReal;
  let baseDisplay = path.join(projectReal, "assets");
  const ask = String(subdir ?? "").trim();
  if (ask && ask !== "/" && ask !== ".") {
    const insideAssets = (p) =>
      p === assetsReal || p.startsWith(assetsReal + path.sep);
    const joined = path.resolve(baseReal, ask);
    if (!insideAssets(joined)) throw new Error(`subdir escapa de assets/: ${subdir}`);
    baseDisplay = path.join(baseDisplay, path.relative(assetsReal, joined));
    baseReal = await fs.realpath(joined).catch(() => null);
    if (!baseReal) throw new Error(`subdir no existe: ${subdir}`);
    if (!insideAssets(baseReal)) throw new Error(`subdir escapa de assets/: ${subdir}`);
  }

  const insideAssets = (p) =>
    p === assetsReal || p.startsWith(assetsReal + path.sep);
  const files = [];
  let truncated = false;

  async function walk(dir, depth, displayDir = dir) {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const de of dirents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (truncated) return;
      if (de.name.startsWith(".")) continue;
      let real = path.join(dir, de.name);
      const displayed = path.join(displayDir, de.name);
      if (de.isSymbolicLink()) {
        const linked = await fs.realpath(real).catch(() => null);
        if (!linked || !insideAssets(linked)) continue; // symlink fuera de assets/
        real = linked;
      }
      let st;
      try {
        st = await fs.stat(real);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth + 1 <= MAX_DEPTH) await walk(real, depth + 1, displayed);
        continue; // más profundo que MAX_DEPTH: omitido (documentado)
      }
      if (!st.isFile()) continue;
      if (files.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      files.push({
        path: path.relative(projectReal, displayed).split(path.sep).join("/"),
        size: st.size,
        modified: st.mtime.toISOString(),
        type: typeFor(de.name),
      });
    }
  }

  await walk(baseReal, 0, baseDisplay);
  return { files, truncated };
}
