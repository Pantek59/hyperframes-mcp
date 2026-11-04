#!/usr/bin/env node
/**
 * hyperframes-mcp — self-hosted MCP server that exposes the HyperFrames CLI
 * (render / snapshot / lint / compositions / init) as agent tools.
 *
 * Our own server (not HeyGen's hosted connector, not the browser WebMCP
 * surface): it runs on OUR infra and our agents connect to OUR endpoint.
 *
 * Transports:
 *   - stdio  (MCP_TRANSPORT=stdio)  → for local agents (Claude Code, Cursor…)
 *   - http   (MCP_TRANSPORT=http)   → hosted, multi-agent (Dokploy + Traefik)
 *
 * Env:
 *   HF_ROOT       upstream checkout (default /app/hf)
 *   HF_CLI        CLI entry (default $HF_ROOT/packages/cli/bin/hyperframes.mjs)
 *   HF_WORKSPACE  where projects live (default /data/projects)
 *   MCP_TRANSPORT stdio | http (default stdio)
 *   PORT          HTTP port (default 8080)
 *   MCP_AUTH_TOKEN  if set, HTTP requires "Authorization: Bearer <token>"
 *   HF_RANDOMIZE_OUTPUT  false restores legacy `-o` handling (default: on,
 *                 renders get unguessable randomised paths under renders/)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { JobQueue } from "./jobs.js";
import { renderOutputArgument } from "./render-output.js";
import { withPublicUrls } from "./public-url.js";
import { listAssets, addFileLinks, ASSETS_MAX_DEPTH, ASSETS_MAX_ENTRIES } from "./assets.js";
import { handleFiles, parsePublicPrefixes } from "./files.js";
import { isAuthorized, authEnabled } from "./auth.js";
import { createTtsApiRunner } from "./tts-api.js";
import { createWhisperXRunner } from "./whisperx.js";
import { createTtsUploadVoiceRunner, listVoices } from "./tts-voices.js";
import { shareAssetToRenders } from "./share.js";

const HF_ROOT = process.env.HF_ROOT || "/app/hf";
const HF_CLI =
  process.env.HF_CLI || path.join(HF_ROOT, "packages/cli/bin/hyperframes.mjs");
const WORKSPACE = path.resolve(process.env.HF_WORKSPACE || "/data/projects");
const TRANSPORT = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
const PORT = parseInt(process.env.PORT || "8080", 10);
const NODE = process.execPath;

const RENDER_TIMEOUT_MS = parseInt(process.env.HF_RENDER_TIMEOUT_MS || "1800000", 10);
const TTS_API_TIMEOUT_MS = parseInt(process.env.TTS_API_TIMEOUT_MS || "300000", 10);
const WHISPERX_TIMEOUT_MS = parseInt(process.env.WHISPERX_TIMEOUT_MS || "1800000", 10);
const WAIT_MAX_MS = parseInt(process.env.HF_WAIT_MAX_MS || "600000", 10);
// Optional /files/ restriction to <project>/<prefix>/… (default off).
const FILES_PUBLIC_PREFIXES = parsePublicPrefixes(process.env.HF_FILES_PUBLIC_PREFIX_ONLY);

// Single shared job queue for the whole process: renders are CPU-bound, so we
// enqueue and return a job_id instead of holding the HTTP request open.
const queue = new JobQueue({
  node: NODE,
  cli: HF_CLI,
  workspace: WORKSPACE,
  defaultTimeoutMs: RENDER_TIMEOUT_MS,
});
queue.registerRunner("tts_generate", createTtsApiRunner());
queue.registerRunner("whisperx_transcribe", createWhisperXRunner());
queue.registerRunner("tts_upload_voice", createTtsUploadVoiceRunner());

// ── CLI runner ───────────────────────────────────────────────────────────────
function runHF(args, timeoutMs = 600000) {
  return new Promise((resolve) => {
    execFile(
      NODE,
      [HF_CLI, ...args],
      {
        cwd: WORKSPACE,
        timeout: timeoutMs,
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, HF_WORKSPACE: WORKSPACE },
      },
      (err, stdout, stderr) => {
        const timedOut = !!(err && (err.killed || err.signal === "SIGTERM"));
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: stdout || "",
          stderr: stderr || "",
          timedOut,
          error: err,
        });
      }
    );
  });
}

const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

function combined(r) {
  const out = `${r.stdout}\n${r.stderr}`.trim();
  if (r.timedOut) return `⏱ timeout tras ${RENDER_TIMEOUT_MS / 1000}s\n\n${out}`;
  return out || "(sin salida)";
}

/** Resolve a project name/path and confine it to the workspace. */
async function resolveProject(nameOrPath) {
  const raw = nameOrPath ? String(nameOrPath) : "";
  const p = raw
    ? path.isAbsolute(raw)
      ? raw
      : path.join(WORKSPACE, raw)
    : WORKSPACE;
  const rp = path.resolve(p);
  if (rp !== WORKSPACE && !rp.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`Proyecto fuera del workspace permitido: ${rp}`);
  }
  await fs.access(rp);
  return rp;
}

const rel = (abs) => path.relative(WORKSPACE, abs) || ".";

// ── Job helpers ──────────────────────────────────────────────────────────────
function jobFiles(job) {
  if (!job.outputDir || !job.outputs || job.outputs.length === 0) return [];
  const relDir = path.relative(WORKSPACE, job.outputDir);
  return job.outputs.map((f) => `/files/${relDir}/${f}`);
}

function jobSummary(job, message) {
  return JSON.stringify(
    {
      job_id: job.id,
      kind: job.kind,
      status: job.status,
      project: job.project,
      created_at: job.createdAt,
      message: message || undefined,
    },
    null,
    2
  );
}

function jobDetail(job) {
  const out = {
    job_id: job.id,
    kind: job.kind,
    status: job.status,
    project: job.project,
    created_at: job.createdAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    exit_code: job.exitCode,
    error: job.error,
    artifacts: job.artifacts || [],
    warnings: job.warnings || [],
    // renders/ entries carry a public download `url` when PUBLIC_BASE_URL is set
    files: withPublicUrls(jobFiles(job)),
  };
  const tail = (job.tail || []).slice(-40).join("\n");
  return `${JSON.stringify(out, null, 2)}${
    tail ? `\n\n--- log (últimas líneas) ---\n${tail}` : ""
  }`;
}

// ── MCP server (one instance per session / per HTTP request) ─────────────────
function buildServer() {
  const server = new McpServer({ name: "hyperframes", version: "0.1.0" });

  server.registerTool(
    "list_projects",
    { description: "Lista los proyectos HyperFrames del workspace (cada uno con su index.html)." },
    async () => {
      const entries = await fs.readdir(WORKSPACE, { withFileTypes: true });
      const projects = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const hasIndex = await fs
          .access(path.join(WORKSPACE, e.name, "index.html"))
          .then(() => true)
          .catch(() => false);
        if (hasIndex) projects.push(e.name);
      }
      return ok(JSON.stringify(projects.sort(), null, 2));
    }
  );

  server.registerTool(
    "list_compositions",
    {
      description: "Lista las composiciones de un proyecto (archivos .html). Salida JSON.",
      inputSchema: { project: z.string().describe("Nombre del proyecto dentro del workspace") },
    },
    async ({ project }) => {
      const dir = await resolveProject(project);
      const r = await runHF(["compositions", dir, "--json"], 120000);
      return r.code === 0 ? ok(combined(r)) : fail(combined(r));
    }
  );

  server.registerTool(
    "list_assets",
    {
      description:
        "Lista (SOLO LECTURA) los archivos que los usuarios subieron en <project>/assets/ " +
        "(imágenes, audio, video, fonts). Devuelve JSON: { files, truncated } con la ruta relativa " +
        'al proyecto tal cual se usa en las composiciones — p. ej. src="assets/logo.png" —, el tamaño ' +
        "en bytes, fecha de modificación y tipo (image/audio/video/font/other). Cada entrada lleva " +
        "`link` = ruta interna /files/<project>/assets/… (requiere Authorization Bearer). Para enlaces " +
        "públicos clicables usa share_asset. Añade assets a una composición con esa ruta. Lista " +
        `recursiva hasta ${ASSETS_MAX_DEPTH} niveles de carpetas y máximo ${ASSETS_MAX_ENTRIES} archivos. ` +
        "Sin assets/ no es error: devuelve lista vacía.",
      inputSchema: {
        project: z.string().describe("Nombre del proyecto"),
        subdir: z
          .string()
          .optional()
          .describe("Subcarpeta dentro de assets/ (ej. 'logos'); no admite rutas fuera de assets/"),
      },
    },
    async ({ project, subdir }) => {
      const dir = await resolveProject(project);
      let out;
      try {
        out = await listAssets(dir, subdir);
      } catch (e) {
        return fail(String(e.message || e));
      }
      const files = addFileLinks(out.files, rel(dir));
      return ok(
        JSON.stringify({ project: rel(dir), subdir: subdir || undefined, files, truncated: out.truncated }, null, 2)
      );
    }
  );

  server.registerTool(
    "lint_project",
    {
      description:
        "Corre el linter de HyperFrames sobre un proyecto (accesibilidad, layout, motion). Salida JSON.",
      inputSchema: {
        project: z.string().describe("Nombre del proyecto"),
        verbose: z.boolean().optional().describe("Incluir hallazgos de nivel info"),
      },
    },
    async ({ project, verbose }) => {
      const dir = await resolveProject(project);
      const args = ["lint", dir, "--json"];
      if (verbose) args.push("--verbose");
      const r = await runHF(args, 180000);
      return ok(combined(r));
    }
  );

  server.registerTool(
    "render_video",
    {
      description:
        "Renderiza un proyecto/composición a MP4 (u otro formato: webm, mov, gif, png-sequence). " +
        "Por defecto ENCOLA el trabajo y devuelve un job_id — el render es pesado y no debe " +
        "bloquear la request; sigue el avance con get_job / wait_job. Usa wait=true para clips cortos. " +
        'Cuando el job queda "succeeded", los archivos de renders/ llevan un campo `url` público; ' +
        "dásela al usuario como enlace markdown.",
      inputSchema: {
        project: z.string().describe("Nombre del proyecto"),
        composition: z
          .string()
          .optional()
          .describe("Archivo de composición (ej. compositions/intro.html). Omitir = index.html"),
        output: z
          .string()
          .optional()
          .describe(
            "Nombre legible para el archivo (p.ej. 'intro'); la ruta final SIEMPRE queda " +
              "bajo renders/ del proyecto con un prefijo aleatorio no adivinable (HF_RANDOMIZE_OUTPUT=true)"
          ),
        fps: z.string().optional().describe("FPS (24,30,60… o racional 30000/1001)"),
        quality: z
          .string()
          .optional()
          .describe("draft | looks (def) | delivery | standard | high"),
        format: z.string().optional().describe("mp4 (def) | webm | mov | gif | png-sequence"),
        wait: z
          .boolean()
          .optional()
          .describe("true = bloquear hasta terminar (máx HF_WAIT_MAX_MS). Def false = encolar."),
        timeout_ms: z.number().optional().describe("Timeout del render en ms (def 1800000)"),
      },
    },
    async ({ project, composition, output, fps, quality, format, wait, timeout_ms }) => {
      const dir = await resolveProject(project);
      const args = ["render", dir];
      if (composition) args.push("-c", composition);
      const outArg = renderOutputArgument({ output, format });
      if (outArg) args.push("-o", outArg);
      if (fps) args.push("-f", fps);
      if (quality) args.push("-q", quality);
      if (format) args.push("--format", format);
      const job = queue.enqueue({
        kind: "render",
        project: rel(dir),
        argv: args,
        cwd: dir,
        timeoutMs: timeout_ms || RENDER_TIMEOUT_MS,
        outputDir: path.join(dir, "renders"),
      });
      if (!wait) return ok(jobSummary(job, "Encolado. Consulta con get_job / wait_job."));
      const done = await queue.waitFor(job.id, Math.min(timeout_ms || WAIT_MAX_MS, WAIT_MAX_MS));
      return done && done.status === "succeeded" ? ok(jobDetail(done)) : fail(jobDetail(done || job));
    }
  );

  server.registerTool(
    "snapshot_frames",
    {
      description:
        "Captura frames PNG de una composición para control visual de calidad. " +
        "Por defecto ENCOLA y devuelve un job_id (get_job / wait_job).",
      inputSchema: {
        project: z.string().describe("Nombre del proyecto"),
        frames: z.string().optional().describe("Nº de frames equiespaciados (def 5)"),
        at: z.string().optional().describe("Timestamps en segundos, ej '3.0,10.5,18.0'"),
        wait: z.boolean().optional().describe("true = bloquear hasta terminar. Def false = encolar."),
        timeout_ms: z.number().optional().describe("Timeout en ms (def 900000)"),
      },
    },
    async ({ project, frames, at, wait, timeout_ms }) => {
      const dir = await resolveProject(project);
      const args = ["snapshot", dir];
      if (frames) args.push("--frames", frames);
      if (at) args.push("--at", at);
      const job = queue.enqueue({
        kind: "snapshot",
        project: rel(dir),
        argv: args,
        cwd: dir,
        timeoutMs: timeout_ms || 900000,
        outputDir: path.join(dir, "snapshots"),
      });
      if (!wait) return ok(jobSummary(job, "Encolado. Consulta con get_job / wait_job."));
      const done = await queue.waitFor(job.id, Math.min(timeout_ms || WAIT_MAX_MS, WAIT_MAX_MS));
      return done && done.status === "succeeded" ? ok(jobDetail(done)) : fail(jobDetail(done || job));
    }
  );

  server.registerTool(
    "tts_generate",
    {
      description:
        "Lee un archivo UTF-8 de assets/ y genera un WAV mediante el endpoint TTS-API configurado (/v1/audio/speech). " +
        "Opcionalmente usa una `voice` específica para esta llamada — p. ej. una voz clonada registrada con " +
        "tts_upload_voice (confirma los nombres con list_voices). El trabajo se encola en la cola compartida; " +
        "consulta get_job / wait_job para obtener la ruta del resultado.",
      inputSchema: {
        project: z.string().describe("Nombre del proyecto"),
        filename: z.string().describe("Archivo de texto relativo a assets/, por ejemplo narration/script.txt"),
        voice: z
          .string()
          .max(200)
          .optional()
          .describe("Voz para esta llamada (ej. nombre de una voz clonada). Def: TTS_API_VOICE del servidor."),
        wait: z.boolean().optional().describe("true = esperar el resultado. Def false = encolar."),
        timeout_ms: z.number().int().positive().max(3600000).optional().describe("Timeout del job en ms."),
      },
    },
    async ({ project, filename, voice, wait, timeout_ms }) => {
      const dir = await resolveProject(project);
      const job = queue.enqueue({
        kind: "tts_generate",
        project: rel(dir),
        params: { filename, voice: voice || undefined },
        timeoutMs: timeout_ms ?? TTS_API_TIMEOUT_MS,
      });
      if (!wait) return ok(jobSummary(job, "Encolado. Consulta con get_job / wait_job."));
      const done = await queue.waitFor(job.id, Math.min(timeout_ms || WAIT_MAX_MS, WAIT_MAX_MS));
      return done && done.status === "succeeded" ? ok(jobDetail(done)) : fail(jobDetail(done || job));
    }
  );

  server.registerTool(
    "tts_upload_voice",
    {
      description:
        "Clona una voz: sube una muestra de audio de assets/ al endpoint de voces del TTS-API " +
        "(/v1/audio/voices, multipart) para registrarla como `voice` reutilizable en tts_generate. " +
        "Ética y legalidad: SOLO muestras cuya voz está autorizada a clonar (es la tuya o tienes permiso explícito); " +
        "el endpoint exige una declaración de consent. El trabajo se encola; confirma el registro con list_voices. " +
        "Sin artifacts; el nombre resultante es el `name` indicado.",
      inputSchema: {
        project: z.string().describe("Nombre del proyecto que contiene la muestra en assets/"),
        filename: z
          .string()
          .describe("Archivo de audio relativo a assets/, por ejemplo narration/sample.mp3 (mp3/wav/ogg/flac/…)"),
        name: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,64}$/)
          .describe("Nombre de la voz en el registro (1–64 caracteres, [A-Za-z0-9._-]); usable luego como `voice`"),
        consent: z
          .string()
          .min(1)
          .max(500)
          .describe(
            'Declaración de consentimiento exigida por la API de clonación, p. ej. ' +
            '"I confirm I am the speaker in this sample or have their explicit permission to clone this voice."'
          ),
        ref_text: z
          .string()
          .optional()
          .describe("Transcripción del texto hablado en la muestra (mejora la calidad del clon)"),
        speaker_description: z
          .string()
          .optional()
          .describe("Descripción libre de la voz/locutor (p. ej. 'hombre adulto, tono calmado')"),
        wait: z.boolean().optional().describe("true = esperar el resultado. Def false = encolar."),
        timeout_ms: z.number().int().positive().max(3600000).optional().describe("Timeout del job en ms."),
      },
    },
    async ({ project, filename, name, consent, ref_text, speaker_description, wait, timeout_ms }) => {
      const dir = await resolveProject(project);
      const job = queue.enqueue({
        kind: "tts_upload_voice",
        project: rel(dir),
        params: { filename, name, consent, refText: ref_text, speakerDescription: speaker_description },
        timeoutMs: timeout_ms ?? TTS_API_TIMEOUT_MS,
      });
      if (!wait) return ok(jobSummary(job, `Encolado. Consulta con get_job / wait_job o confirma con list_voices (${name}).`));
      const done = await queue.waitFor(job.id, Math.min(timeout_ms || WAIT_MAX_MS, WAIT_MAX_MS));
      return done && done.status === "succeeded" ? ok(jobDetail(done)) : fail(jobDetail(done || job));
    }
  );

  server.registerTool(
    "list_voices",
    {
      description:
        "Lista las voces disponibles en el TTS-API (/v1/audio/voices): la voz por defecto y las voces " +
        "clonadas registradas. úsala para elegir el parámetro `voice` de tts_generate.",
      inputSchema: {},
    },
    async () => {
      try {
        const registry = await listVoices();
        return ok(JSON.stringify(registry, null, 2));
      } catch (e) {
        return fail(String(e.message || e));
      }
    }
  );

  server.registerTool(
    "share_asset",
    {
      description:
        "Publica un archivo de assets/ en la carpeta renders/ del proyecto con un nombre no adivinable y " +
        "devuelve una URL pública de descarga (token-free, cuando PUBLIC_BASE_URL está configurado). " +
        "úsala cuando el usuario necesita un enlace descargable de un asset (sin auth): el archivo copiado " +
        "queda protegido solo por el tramo aleatorio de su nombre.",
      inputSchema: {
        project: z.string().describe("Nombre del proyecto"),
        filename: z.string().describe("Archivo relativo a assets/, p. ej. narration/voice.wav"),
        name: z
          .string()
          .optional()
          .describe("Nombre legible para el archivo compartido (se sanitiza; def: el nombre original)"),
      },
    },
    async ({ project, filename, name }) => {
      const dir = await resolveProject(project);
      try {
        const shared = await shareAssetToRenders({
          workspace: WORKSPACE,
          projectDir: dir,
          filename,
          name,
        });
        return ok(
          JSON.stringify(
            {
              project: rel(dir),
              file: shared.path,
              url: shared.url,
              note: shared.url
                ? "URL pública; pásala al usuario como enlace markdown."
                : "PUBLIC_BASE_URL no está configurado: la ruta /files/ requiere Authorization Bearer.",
            },
            null,
            2
          )
        );
      } catch (e) {
        return fail(String(e.message || e));
      }
    }
  );

  server.registerTool(
    "whisperx_transcribe",
    {
      description:
        "Transcribe un archivo de audio de assets/ con WhisperX local en CPU y guarda un JSON con timestamps. " +
        "El trabajo se encola en la cola compartida; consulta get_job / wait_job para obtener la ruta del resultado.",
      inputSchema: {
        project: z.string().describe("Nombre del proyecto"),
        filename: z.string().describe("Archivo de audio relativo a assets/, por ejemplo narration/voice.wav"),
        wait: z.boolean().optional().describe("true = esperar el resultado. Def false = encolar."),
        timeout_ms: z.number().int().positive().max(7200000).optional().describe("Timeout del job en ms."),
        language: z.string().regex(/^[a-z]{2,3}$/i).optional().describe("Código de idioma WhisperX (omitir para detección automática)."),
      },
    },
    async ({ project, filename, wait, timeout_ms, language }) => {
      const dir = await resolveProject(project);
      const job = queue.enqueue({
        kind: "whisperx_transcribe",
        project: rel(dir),
        params: { filename, language },
        timeoutMs: timeout_ms ?? WHISPERX_TIMEOUT_MS,
      });
      if (!wait) return ok(jobSummary(job, "Encolado. Consulta con get_job / wait_job."));
      const done = await queue.waitFor(job.id, Math.min(timeout_ms ?? WAIT_MAX_MS, WAIT_MAX_MS));
      return done && done.status === "succeeded" ? ok(jobDetail(done)) : fail(jobDetail(done || job));
    }
  );

  server.registerTool(
    "create_project",
    {
      description:
        "Crea un proyecto HyperFrames nuevo a partir de un ejemplo. Devuelve el nombre del proyecto.",
      inputSchema: {
        name: z.string().describe("Nombre del proyecto nuevo"),
        example: z
          .string()
          .optional()
          .describe("Ejemplo base (blank, warm-grain, swiss-grid, kinetic-type, product-promo…)"),
      },
    },
    async ({ name, example }) => {
      const args = ["init", name];
      if (example) args.push("-e", example);
      const r = await runHF(args, 300000);
      return r.code === 0 ? ok(combined(r)) : fail(combined(r));
    }
  );

  server.registerTool(
    "get_job",
    {
      description:
        "Estado, log y salidas de un job (render, snapshot o audio) por su job_id. " +
        'Si terminó con éxito, los archivos de renders/ incluyen una `url` pública de descarga ' +
        "(si PUBLIC_BASE_URL está configurado); pásala al usuario tal cual, como enlace markdown.",
      inputSchema: { job_id: z.string().describe("ID devuelto por render_video / snapshot_frames") },
    },
    async ({ job_id }) => {
      const job = queue.get(job_id);
      if (!job) return fail(`job no encontrado: ${job_id}`);
      return ok(jobDetail(job));
    }
  );

  server.registerTool(
    "list_jobs",
    {
      description: "Lista los jobs recientes (más nuevos primero) y el estado de la cola.",
      inputSchema: { limit: z.number().optional().describe("Máximo de jobs (def 20)") },
    },
    async ({ limit }) => {
      const jobs = queue.list(limit || 20).map((j) => ({
        job_id: j.id,
        kind: j.kind,
        status: j.status,
        project: j.project,
        created_at: j.createdAt,
        finished_at: j.finishedAt,
      }));
      return ok(JSON.stringify({ queue: queue.stats(), jobs }, null, 2));
    }
  );

  server.registerTool(
    "write_project_file",
    {
      description:
        "Escribe (o crea) un archivo dentro de un proyecto del workspace: HTML, CSS, SVG, JSON… " +
        "Crea los directorios necesarios. Para binarios (PNG/JPG/MP4) usa encoding=base64. " +
        "Permite crear un proyecto nuevo desde cero escribiendo su index.html.",
      inputSchema: {
        project: z.string().describe("Nombre del proyecto (se crea si no existe)"),
        path: z
          .string()
          .describe("Ruta relativa dentro del proyecto, ej 'index.html' o 'assets/z.png'"),
        content: z.string().describe("Contenido (texto UTF-8, o base64 si encoding=base64)"),
        encoding: z.enum(["utf8", "base64"]).optional().describe("Def utf8"),
      },
    },
    async ({ project, path: relPath, content, encoding }) => {
      const dir = path.resolve(WORKSPACE, String(project));
      if (dir !== WORKSPACE && !dir.startsWith(WORKSPACE + path.sep)) {
        return fail(`proyecto fuera del workspace: ${project}`);
      }
      const target = path.resolve(dir, String(relPath));
      if (target !== dir && !target.startsWith(dir + path.sep)) {
        return fail(`ruta fuera del proyecto: ${relPath}`);
      }
      const data =
        encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, data);
        return ok(`escrito ${rel(target)} (${data.length} bytes)`);
      } catch (e) {
        return fail(`no se pudo escribir ${relPath}: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "wait_job",
    {
      description: "Bloquea hasta que el job termine (o se agote el timeout). Útil para agentes sin polling.",
      inputSchema: {
        job_id: z.string(),
        timeout_ms: z.number().optional().describe("Máxima espera en ms (def 600000)"),
      },
    },
    async ({ job_id, timeout_ms }) => {
      const cap = Math.min(timeout_ms || WAIT_MAX_MS, WAIT_MAX_MS);
      const job = await queue.waitFor(job_id, cap);
      if (!job) return fail(`job no encontrado: ${job_id}`);
      return job.status === "succeeded" ? ok(jobDetail(job)) : fail(jobDetail(job));
    }
  );

  server.registerTool(
    "cancel_job",
    {
      description: "Cancela un job en cola o en ejecución.",
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }) => {
      const r = queue.cancel(job_id);
      return r.ok ? ok(JSON.stringify(r)) : fail(JSON.stringify(r));
    }
  );

  return server;
}

// ── HTTP transport (hosted) ──────────────────────────────────────────────────
function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, Accept, Last-Event-ID"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

async function startHttp() {
  const srv = createServer(async (req, res) => {
    cors(res);
    const url = new URL(req.url, "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    // /health is public so orchestrators can probe liveness.
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", auth: authEnabled, queue: queue.stats() }));
    }

    // Auth (constant-time bearer) guards everything else.
    if (!isAuthorized(req.headers)) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"jsonrpc":"2.0","error":{"code":-32001,"message":"unauthorized"}}');
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify(
          {
            name: "hyperframes-mcp",
            mcp_endpoint: "/mcp",
            files: "/files/<path-relative-to-workspace>",
            tools: [
              "list_projects",
              "list_compositions",
              "list_assets",
              "lint_project",
              "render_video",
              "snapshot_frames",
              "tts_generate",
              "tts_upload_voice",
              "list_voices",
              "share_asset",
              "whisperx_transcribe",
              "create_project",
              "write_project_file",
              "get_job",
              "list_jobs",
              "wait_job",
              "cancel_job",
            ],
            jobs: "/jobs",
          },
          null,
          2
        )
      );
    }

    // Serve workspace files (renders, snapshots, sources) with traversal,
    // symlink, content-type and range-request protections — see src/files.js.
    if (
      await handleFiles(req, res, { workspace: WORKSPACE, prefixes: FILES_PUBLIC_PREFIXES })
    ) {
      return;
    }

    // Job observability (human / dashboard / CI friendly).
    if (req.method === "GET" && url.pathname === "/jobs") {
      const jobs = queue.list(100).map((j) => ({
        job_id: j.id,
        kind: j.kind,
        status: j.status,
        project: j.project,
        created_at: j.createdAt,
        finished_at: j.finishedAt,
        exit_code: j.exitCode,
      }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ queue: queue.stats(), jobs }, null, 2));
    }
    if (req.method === "GET" && /^\/jobs\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.slice("/jobs/".length);
      const job = queue.get(id);
      res.writeHead(job ? 200 : 404, { "content-type": "application/json" });
      return res.end(
        JSON.stringify(
          job ? { ...job, files: withPublicUrls(jobFiles(job)) } : { error: "not found", job_id: id },
          null,
          2
        )
      );
    }
    if (req.method === "POST" && /^\/jobs\/[^/]+\/cancel$/.test(url.pathname)) {
      const id = url.pathname.slice("/jobs/".length, -"/cancel".length);
      const r = queue.cancel(id);
      res.writeHead(r.ok ? 200 : 409, { "content-type": "application/json" });
      return res.end(JSON.stringify(r));
    }

    if (url.pathname === "/mcp") {
      let parsed;
      try {
        const raw = await readBody(req);
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(
          '{"jsonrpc":"2.0","error":{"code":-32700,"message":"parse error"}}'
        );
      }
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  srv.listen(PORT, "0.0.0.0", () => {
    console.error(`[hyperframes-mcp] HTTP listening on 0.0.0.0:${PORT} (mcp: /mcp)`);
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  if (TRANSPORT === "http") {
    await startHttp();
  } else {
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[hyperframes-mcp] stdio transport ready");
  }
}

main().catch((err) => {
  console.error("[hyperframes-mcp] fatal:", err);
  process.exit(1);
});
