# hyperframes-mcp

**Self-hosted MCP server** that exposes the [HyperFrames](https://github.com/heygen-com/hyperframes)
CLI as agent tools. Runs on our own infra — agents connect to **our** endpoint,
not HeyGen's hosted connector (`mcp.heygen.com`) nor the browser-only WebMCP
surface of the Studio.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | Lists HyperFrames projects in the workspace |
| `list_compositions` | Lists a project's compositions (JSON) |
| `list_assets` | Read-only listing of user-uploaded files under `<project>/assets/` (path, size, type) |
| `lint_project` | Runs the HyperFrames linter (a11y/layout/motion) |
| `render_video` | Renders a project/composition → mp4/webm/mov/gif/png-sequence |
| `snapshot_frames` | Captures PNG frames for visual QA |
| `higgs_audio_tts` | Reads UTF-8 text from `assets/` and generates a WAV through the configured Higgs Audio API |
| `whisperx_transcribe` | Transcribes an audio asset locally with CPU-only WhisperX to timed JSON |
| `create_project` | Scaffolds a new project from an example |
| `write_project_file` | Writes/creates a file inside a project (HTML, CSS, SVG, JSON, base64 binaries) |
| `get_job` | Status, log, artifact paths, and warnings for a render/audio job |
| `list_jobs` | Recent jobs and queue state |
| `wait_job` | Blocks until a job finishes (or times out) |
| `cancel_job` | Cancels a queued or running job |

Rendering runs inside the container (chrome-headless-shell + ffmpeg bundled).
WhisperX runs locally on CPU; Higgs speech generation uses the separately
configured OpenAI-compatible endpoint.

### Heavy ops are queued

`render_video`, `snapshot_frames`, `higgs_audio_tts`, and `whisperx_transcribe`
**enqueue** the work and return a `job_id` immediately — audio generation and
transcription can also take a while and must not hold the HTTP request open.
Follow it with `get_job` / `wait_job` / `list_jobs` / `cancel_job`, or pass
`wait: true` for short clips. Jobs are persisted to disk (`HF_JOBS_DIR`) so their
status survives restarts; all render and audio work shares
`HF_JOB_CONCURRENCY`.

### Audio tools

Both audio tools take `project` and `filename`, where `filename` is relative to
the project's `assets/` directory (for example `narration/script.txt`, not
`assets/narration/script.txt`). Inputs can be in nested asset folders. Each job
writes a unique output next to its input, such as
`assets/narration/script.<job-id>.wav` or
`assets/narration/voice.<job-id>.json`, without replacing existing files.
Successful job details include the exact project-relative `artifacts` path;
`list_assets` will list the new file.

```json
{
  "project": "demo",
  "filename": "narration/script.txt",
  "wait": false
}
```

Use that input with `higgs_audio_tts`. For `whisperx_transcribe`, provide an
audio filename such as `narration/voice.wav`; optional `language` is a
two- or three-letter Whisper language code. Omit it for language detection.
WhisperX JSON contains segment timestamps and word timings when alignment is
available. If the language cannot be aligned, the job reports a warning and
retains the segment timestamps rather than inventing word times.

Set `wait: true` to wait synchronously for shorter jobs, or keep the default
queued mode and poll with `get_job`/`wait_job`. A tool's `timeout_ms` controls
the job timeout; `HF_WAIT_MAX_MS` separately caps how long a single wait request
blocks. Cancellation aborts the local WhisperX subprocess or Higgs HTTP request,
but cannot guarantee that a remote Higgs server stops its own computation.

Audio artifacts are **not public render URLs**. `/files/` still requires
`MCP_AUTH_TOKEN` when auth is enabled and is subject to
`HF_FILES_PUBLIC_PREFIX_ONLY`; do not expose `assets/` through a public render
host. The `files[].url` behavior applies only to renders.

Higgs requires `HIGGS_AUDIO_BASE_URL`, `HIGGS_AUDIO_MODEL`, and
`HIGGS_AUDIO_VOICE`; an optional bearer token is configured as
`HIGGS_AUDIO_API_KEY`. The adapter appends `/v1/audio/speech`, sends the model,
text, voice, and `response_format: "wav"`, and accepts only bounded valid WAV
bytes. Leave the feature unconfigured if the endpoint should not be used; the
MCP server still starts and only the TTS job fails with a configuration error.

WhisperX is installed in the image as Python 3.11 / WhisperX 3.8.6 with
CPU-only PyTorch. The default model is `base`; select another installed
WhisperX model with `WHISPERX_MODEL`. Model and language-alignment files download
on first use, so allow outbound network access then or pre-populate the
`hf-mcp-whisperx` volume, which grows as additional models are used. CPU
inference is compute-intensive and may be slower than real time; provision
several CPU cores and at least 8 GiB RAM for practical use, and add memory for
larger models, long audio, or concurrent renders.

For Docker Compose, copy `.env.example` to `.env` (which is Git-ignored) if it
does not already exist. Set the required Higgs base URL, model, and voice; add
`HIGGS_AUDIO_API_KEY` if the endpoint requires authentication. Start or rebuild
the container with `docker compose up --build -d`.
Compose preserves WhisperX downloads in the `hf-mcp-whisperx` named volume.
The Compose build context points to the repository's remote `main` branch, so
`--build` uses committed remote code. To test the current checkout instead, run
`docker build -t hyperframes-mcp:latest .` followed by
`docker compose up -d --no-build`.

### Renders get unguessable filenames

By default (`HF_RANDOMIZE_OUTPUT=true`) every render is written to
`renders/<32 random hex chars>-<readable-name><ext>` inside the project; the
tool's `output` input is only used to build the readable suffix (traversal is
impossible). Because the public files route relies on the path staying secret,
these two mechanisms go together — see [Public file route](#public-file-route).
Set `HF_RANDOMIZE_OUTPUT=false` to restore the legacy behaviour (raw `-o`,
default CLI naming) for local use only. `png-sequence` writes frames as a
directory `renders/<token>-<name>/`; job results list the individual frames.

### Public URLs in job results

When `PUBLIC_BASE_URL` is set (e.g. `https://files.example.net`, no trailing
slash), every `files[]` entry under a project's `renders/` gets a `url` field —
the full public download link, percent-encoded. Feed that `url` to the user as
a markdown link; don't build URLs by hand. Snapshots, sources and assets never
get a `url` (they are not exposed by the public route). Without the env var,
`files[]` entries stay as plain `/files/<workspace-relative-path>` strings.

## Transports

- **HTTP (hosted):** `MCP_TRANSPORT=http`, served at `POST /mcp`
  (Streamable HTTP, stateless). Rendered files are downloadable at
  `GET /files/<path-relative-to-workspace>`.
- **stdio (local):** `MCP_TRANSPORT=stdio` — for Claude Code / Cursor / Codex.

### Hosted (this deployment)

Live: **https://hyperframes-mcp.lab.whitelabel.lat**

```json
{
  "mcpServers": {
    "hyperframes": {
      "type": "http",
      "url": "https://hyperframes-mcp.lab.whitelabel.lat/mcp"
    }
  }
}
```

If `MCP_AUTH_TOKEN` is set, add `"headers": { "Authorization": "Bearer <token>" }`.

### Local (stdio)

```json
{
  "mcpServers": {
    "hyperframes": {
      "command": "docker",
      "args": ["run","-i","--rm","-e","MCP_TRANSPORT=stdio","hyperframes-mcp:latest"]
    }
  }
}
```

## Endpoints

- `POST /mcp` — MCP (Streamable HTTP)
- `GET /health` — liveness (public; includes queue state)
- `GET /jobs` — list jobs (queue state + recent)
- `GET /jobs/<id>` — single job status/log
- `POST /jobs/<id>/cancel` — cancel a job
- `GET /files/<path>` — workspace file download (see below; also accepts HEAD)
- `GET /` — tool index

### Public file route

Auth behaviour is uniform: when `MCP_AUTH_TOKEN` is set, every request to
`/files/…` (like everything except `/health`) requires
`Authorization: Bearer …` (or `x-api-key`). With no token configured the server
itself is open — protect it at the reverse proxy.

`/files/<path-relative-to-workspace>` hardening:

- Traversal: raw, once- and twice-encoded `..` sequences cannot leave the
  workspace (403/404), and a malformed `%` sequence cannot crash the server.
- Symlinks resolving outside the workspace are refused (realpath check).
- Correct `Content-Type` per extension, `X-Content-Type-Options: nosniff`, and
  script-capable types (html/svg/js/xml/…) come back as
  `Content-Disposition: attachment` — they cannot execute inline.
- Videos send `Accept-Ranges: bytes` and honour single `Range` requests (206),
  so browser playback can seek. `bytes=…` past EOF → 416.
- No directory listings (404 on folders).

#### Serving renders publicly (LibreChat setup)

The intended reverse-proxy setup exposes **only** the renders, e.g. Traefik
routed at `https://files.<domain>/files/{project}/renders/{file}` and nothing
else — `/mcp`, `/jobs` and project sources stay internal (or token-protected at
the server). Two env vars support that:

- `PUBLIC_BASE_URL` — the public files host; makes job results include the
  final `url` (see above).
- `HF_FILES_PUBLIC_PREFIX_ONLY` — optional defence in depth on the server
  itself: restrict `/files/` to `<project>/<prefix>/…` paths. The value may be
  a folder name (`renders`) or a comma-separated list; `true`/`1` means
  `renders`. **Default: off** (existing setups unaffected). Since Traefik
  carries the only public exposure, keep this off unless you want a second
  layer on the server.

Because the public route has no login, render filenames are randomised by
default (see above); anything not under `renders/` must never be pointed at
that public host. A ready-to-use Traefik configuration (labels and file
provider variants) lives in [`docs/traefik.md`](docs/traefik.md).

## Env

| Var | Default | Meaning |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `8080` | HTTP port |
| `MCP_AUTH_TOKEN` | _(empty)_ | If set, require `Authorization: Bearer …`; comma-separated values support rotation. `/health` stays public |
| `HF_WORKSPACE` | `/data/projects` | Where projects live |
| `HF_JOBS_DIR` | `/data/jobs` | Where job records are persisted |
| `HF_JOB_CONCURRENCY` | `1` | Max simultaneous render, TTS, and transcription jobs |
| `HF_JOB_TAIL_LINES` | `200` | Log lines kept per job |
| `HF_WAIT_MAX_MS` | `600000` | Cap for `wait:true` / `wait_job` |
| `HF_ROOT` / `HF_CLI` | `/app/hf` | Upstream checkout / CLI entry |
| `HF_RENDER_TIMEOUT_MS` | `1800000` | Render timeout (30 min) |
| `HIGGS_AUDIO_BASE_URL` | _(unset)_ | Higgs API origin; `/v1/audio/speech` is appended |
| `HIGGS_AUDIO_MODEL` | _(unset)_ | Required model name for Higgs TTS |
| `HIGGS_AUDIO_VOICE` | _(unset)_ | Required voice name for Higgs TTS |
| `HIGGS_AUDIO_API_KEY` | _(empty)_ | Optional bearer token; keep it in ignored `.env`/secret storage |
| `HIGGS_AUDIO_TIMEOUT_MS` | `300000` | Higgs job timeout (5 min) |
| `HIGGS_AUDIO_MAX_TEXT_BYTES` | `65536` | Maximum UTF-8 text asset size |
| `HIGGS_AUDIO_MAX_AUDIO_BYTES` | `26214400` | Maximum accepted WAV response size |
| `WHISPERX_EXECUTABLE` | `whisperx` | WhisperX CLI path (container pins its venv executable) |
| `WHISPERX_MODEL` | `base` | Local transcription model |
| `WHISPERX_MODEL_CACHE_DIR` | `/data/whisperx-cache` | Persistent model/alignment cache directory |
| `WHISPERX_TIMEOUT_MS` | `1800000` | WhisperX job timeout (30 min) |
| `WHISPERX_MAX_AUDIO_BYTES` | `524288000` | Maximum input audio size (500 MiB) |
| `WHISPERX_MAX_JSON_BYTES` | `20971520` | Maximum transcript JSON size (20 MiB) |
| `HF_RANDOMIZE_OUTPUT` | `true` | Random unguessable `renders/<token>-<name>.mp4` outputs; `false` restores legacy `-o` handling |
| `PUBLIC_BASE_URL` | _(empty)_ | Public files host (no trailing slash); when set, `render` jobs return `files[].url` download links |
| `HF_FILES_PUBLIC_PREFIX_ONLY` | _(off)_ | Optional: restrict `/files/` to `<project>/<prefix>/…` (`renders`, CSV list, or `true` = `renders`) |

## Development

```sh
npm install          # only needed for the MCP SDK / stdio usage
npm test             # node --test suite (no CLI/toolchain needed)
docker build -t hyperframes-mcp:latest .
```

Tests use a mock Higgs service and fake WhisperX executable; no external API,
model download, or GPU is needed for `npm test`. They cover audio request/output
contracts, safe asset publication, job cancellation and timeout, alignment
warnings, queue behavior, render-output naming, public URLs, `list_assets`, and
the `/files/` route.

## Notes / roadmap

- Rendering and CPU transcription are CPU/RAM heavy → they run through a **persistent job queue**
  (`src/jobs.js`) with capped concurrency, so the MCP request returns instantly.
- The image is large (Chrome + ffmpeg + CPU PyTorch/WhisperX + the full toolchain) and the build clones
  upstream at a pinned commit (`HF_REF`) for reproducibility.
- Not a fork of upstream — this repo carries only the server + deployment recipe.
