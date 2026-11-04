/**
 * share.js — publish an existing asset to the project's renders/ folder with
 * an unguessable name so it can be served by the public files host.
 *
 * The public /files/ route is token-free for renders/ only (the reverse proxy
 * injects the bearer token and path obscurity is the protection) — assets/
 * stay authenticated. share_asset is the agent-facing bridge: it copies an
 * asset into renders/<32 hex>-<readable-name><ext> and, when PUBLIC_BASE_URL
 * is set, returns the full public download URL — the same shape job results
 * use (see public-url.js).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveAssetInput, publishNoReplace, cleanupPublishedFile } from "./asset-ops.js";
import { sanitizeBaseName } from "./render-output.js";
import { publicBaseUrl } from "./public-url.js";

function percentEncodePath(p) {
  return p.split(path.sep).map(encodeURIComponent).join("/");
}

export async function shareAssetToRenders({
  workspace,
  projectDir,
  filename,
  name,
  publicBaseUrl: explicitBase,
} = {}) {
  const input = await resolveAssetInput({ workspace, projectDir, filename });

  const rendersReal = await fs
    .realpath(path.join(input.projectReal, "renders"))
    .catch(() => null);
  if (!rendersReal || !rendersReal.startsWith(input.projectReal + path.sep)) {
    throw new Error("Project renders directory is missing");
  }

  const token = randomBytes(16).toString("hex");
  const base =
    sanitizeBaseName(name || path.basename(filename)) || "asset";
  const ext = path.extname(input.path).toLowerCase();
  const outputName = `${token}-${base}${ext}`;
  const outputPath = path.join(rendersReal, outputName);

  const tempPath = path.join(rendersReal, `.${token}.${randomUUID()}.tmp`);
  await fs.copyFile(input.path, tempPath);
  const identity = await fs.lstat(tempPath);
  let published = false;
  try {
    await publishNoReplace(tempPath, outputPath, rendersReal, identity);
    published = true;
  } finally {
    if (!published) await cleanupPublishedFile(tempPath, rendersReal, identity).catch(() => {});
  }

  const wsRel = path.relative(workspace, outputPath);
  const internalPath = `/files/${percentEncodePath(wsRel)}`;
  const urlBase = String(explicitBase ?? publicBaseUrl() ?? "").trim().replace(/\/+$/, "");
  return {
    path: internalPath,
    url: urlBase ? `${urlBase}${internalPath}` : null,
    size: identity.size,
  };
}
