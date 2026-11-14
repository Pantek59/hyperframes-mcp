import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

function inside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

async function validateRoots(workspace, projectDir) {
  const workspaceReal = await fs.realpath(workspace).catch(() => null);
  const projectReal = await fs.realpath(projectDir).catch(() => null);
  if (!workspaceReal || !projectReal || !inside(workspaceReal, projectReal)) {
    throw new Error("Project is missing or outside the workspace");
  }
  const assetsReal = await fs.realpath(path.join(projectReal, "assets")).catch(() => null);
  if (!assetsReal || !inside(projectReal, assetsReal)) throw new Error("Project assets directory is missing or unsafe");
  return { workspaceReal, projectReal, assetsReal };
}

function validateFilename(filename) {
  if (typeof filename !== "string" || !filename.trim() || filename.includes("\0") || filename.includes("\\") ||
      path.isAbsolute(filename) || path.win32.isAbsolute(filename)) {
    throw new Error("Filename must be relative to assets/");
  }
  if (filename.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("Filename must stay inside assets/");
  }
}

export async function resolveAssetInput({ workspace, projectDir, filename }) {
  validateFilename(filename);
  const roots = await validateRoots(workspace, projectDir);
  const candidate = path.resolve(roots.assetsReal, filename);
  if (!inside(roots.assetsReal, candidate)) throw new Error("Filename must stay inside assets/");
  const realPath = await fs.realpath(candidate).catch(() => null);
  if (!realPath || !inside(roots.assetsReal, realPath)) throw new Error("Asset is missing or outside assets/");
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new Error("Asset must be a regular file");
  return { ...roots, path: realPath, stat };
}

export async function resolveAssetOutput({ workspace, projectDir, filename, jobId, extension }) {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9-]+$/.test(jobId)) throw new Error("Invalid job id");
  if (typeof extension !== "string" || !/^\.[a-z0-9]{1,8}$/i.test(extension)) throw new Error("Invalid output extension");
  const input = await resolveAssetInput({ workspace, projectDir, filename });
  const parsed = path.posix.parse(path.posix.normalize(filename));
  const requestedParent = path.resolve(input.assetsReal, parsed.dir || ".");
  if (!inside(input.assetsReal, requestedParent)) throw new Error("Output directory is outside assets/");
  const parent = await fs.realpath(requestedParent);
  if (!inside(input.assetsReal, parent)) throw new Error("Output directory is outside assets/");
  const outputName = `${parsed.name}.${jobId}${extension.toLowerCase()}`;
  const outputPath = path.join(parent, outputName);
  const artifactPath = path.posix.join("assets", parsed.dir, outputName);
  return { ...input, inputPath: input.path, parent, path: outputPath, artifactPath };
}

export async function createPrivateTempFile(parent, jobId) {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9-]+$/.test(jobId)) throw new Error("Invalid job id");
  const parentReal = await fs.realpath(parent);
  const tempPath = path.join(parentReal, `.${jobId}.${randomUUID()}.tmp`);
  const handle = await fs.open(tempPath, "wx", 0o600);
  return { path: tempPath, handle };
}

export async function publishNoReplace(tempPath, outputPath, expectedParent, expectedIdentity) {
  const parentReal = await fs.realpath(expectedParent);
  const tempParent = await fs.realpath(path.dirname(tempPath));
  const outputParent = await fs.realpath(path.dirname(outputPath));
  if (tempParent !== parentReal || outputParent !== parentReal) throw new Error("Asset output directory changed");
  const tempStat = await fs.lstat(tempPath);
  if (!tempStat.isFile() || tempStat.isSymbolicLink()) throw new Error("Temporary output must be a regular file");
  if (expectedIdentity && (tempStat.dev !== expectedIdentity.dev || tempStat.ino !== expectedIdentity.ino)) {
    throw new Error("Temporary output changed before publication");
  }
  await fs.link(tempPath, outputPath);
  try {
    await fs.unlink(tempPath);
  } catch (error) {
    await cleanupPublishedFile(outputPath, parentReal, tempStat).catch(() => {});
    throw error;
  }
  return outputPath;
}

export async function cleanupPublishedFile(outputPath, expectedParent, identity) {
  const parent = await fs.realpath(path.dirname(outputPath)).catch(() => null);
  if (parent !== expectedParent) return false;
  const stat = await fs.lstat(outputPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat || !stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
  await fs.unlink(outputPath);
  return true;
}

export async function cleanupTempFile(tempPath) {
  await fs.unlink(tempPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/**
 * Read a bounded UTF-8 text asset (no null bytes, non-empty). Used by the TTS
 * runners so every text input gets the same traversal/size/encoding checks.
 */
export async function readText(inputPath, maxBytes) {
  const handle = await fs.open(inputPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("TTS input must be a regular file");
    if (stat.size > maxBytes) throw new Error(`TTS text exceeds the ${maxBytes}-byte limit`);
    const chunks = [];
    let size = 0;
    while (size <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(8192, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error(`TTS text exceeds the ${maxBytes}-byte limit`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
    } catch {
      throw new Error("TTS input must contain valid UTF-8 text");
    }
    if (!text.trim() || text.includes("\0")) throw new Error("TTS input must be non-empty UTF-8 text");
    return text;
  } finally {
    await handle.close();
  }
}

/**
 * Publish generated bytes as a non-replacing per-job artifact next to the TTS
 * input: write to a private temp file, re-validate the resolved paths and the
 * abort signal, then hard-link into place. Shared by the TTS runners so the
 * semantics stay identical. Returns { path, artifactPath, cleanup }.
 */
export async function publishAssetOutput({
  workspace,
  projectDir,
  filename,
  jobId,
  extension,
  bytes,
  inputPath,
  signal,
}) {
  const output = await resolveAssetOutput({ workspace, projectDir, filename, jobId, extension });
  if (output.inputPath !== inputPath) throw new Error("TTS input changed while the job was running");
  let temporary;
  let identity;
  let published = false;
  try {
    temporary = await createPrivateTempFile(output.parent, jobId);
    await temporary.handle.writeFile(bytes);
    await temporary.handle.sync();
    identity = await temporary.handle.stat();
    await temporary.handle.close();
    if (signal?.aborted) throw signal.reason || new Error("Job canceled");
    const revalidated = await resolveAssetOutput({
      workspace,
      projectDir,
      filename,
      jobId,
      extension,
    });
    if (revalidated.path !== output.path || revalidated.inputPath !== inputPath) {
      throw new Error("TTS asset paths changed while the job was running");
    }
    if (signal?.aborted) throw signal.reason || new Error("Job canceled");
    await publishNoReplace(temporary.path, output.path, output.parent, identity);
    published = true;
  } finally {
    if (temporary) {
      await temporary.handle.close().catch(() => {});
      try {
        await cleanupTempFile(temporary.path);
      } catch (error) {
        if (published) await cleanupPublishedFile(output.path, output.parent, identity).catch(() => {});
        throw error;
      }
    }
  }
  if (signal?.aborted) {
    await cleanupPublishedFile(output.path, output.parent, identity);
    throw signal.reason || new Error("Job canceled");
  }
  return {
    path: output.path,
    artifactPath: output.artifactPath,
    cleanup: () => cleanupPublishedFile(output.path, output.parent, identity),
  };
}
