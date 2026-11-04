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
| `tts_generate` | Reads a UTF-8 text file from `assets/` and generates a WAV asset via the configured OpenAI-compatible TTS-API |
| `whisperx_transcribe` | Transcribes an audio file from `assets/` with local CPU WhisperX into a timed JSON transcript |
| `create_project` | Scaffolds a new project from an example |
| `write_project_file` | Writes/creates a file inside a project (HTML, CSS, SVG, JSON, base64 binaries) |
| `get_job` | Status + log of a render/snapshot job |
| `list_jobs` | Recent jobs and queue state |
| `wait_job` | Blocks until a job finishes (or times out) |
| `cancel_job` | Cancels a queued or running job |

Rendering runs inside the container (chrome-headless-shell + ffmpeg bundled), so
no external accounts or credits are needed.

### Heavy ops are queued

`render_video`, `snapshot_frames`, `tts_generate`, and `whisperx_transcribe` **enqueue** the work and return a `job_id`
immediately — renders and local transcription take time and must not hold the HTTP request open.
Follow it with `get_job` / `wait_job` / `list_jobs` / `cancel_job`, or pass
`wait: true` for quick operations. Jobs are persisted to disk (`HF_JOBS_DIR`) so their
status survives restarts; background job concurrency is capped by `HF_JOB_CONCURRENCY`.

### Audio generation and transcription

- **`tts_generate`:** Reads UTF-8 text from `<project>/assets/...` and calls a configured OpenAI-compatible TTS endpoint (`/v1/audio/speech`). Generates a `.wav` file saved directly next to the input file in `assets/`.
- **`whisperx_transcribe`:** Runs WhisperX locally on CPU against an audio file under `<project>/assets/...`. Saves a timed JSON transcript with word- and segment-level timestamps next to the original asset. Models are downloaded on first use and cached persistently (`WHISPERX_MODEL_CACHE_DIR`).

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
| `MCP_AUTH_TOKEN` | _(empty)_ | If set, require `Authorization: Bearer *** (CSV = rotation). `/health` stays public |
| `HF_WORKSPACE` | `/data/projects` | Where projects live |
| `HF_JOBS_DIR` | `/data/jobs` | Where job records are persisted |
| `HF_JOB_CONCURRENCY` | `1` | Max renders/snapshots running at once |
| `HF_JOB_TAIL_LINES` | `200` | Log lines kept per job |
| `HF_WAIT_MAX_MS` | `600000` | Cap for `wait:true` / `wait_job` |
| `HF_ROOT` / `HF_CLI` | `/app/hf` | Upstream checkout / CLI entry |
| `HF_RENDER_TIMEOUT_MS` | `1800000` | Render timeout (30 min) |
| `HF_RANDOMIZE_OUTPUT` | `true` | Random unguessable `renders/<token>-<name>.mp4` outputs; `false` restores legacy `-o` handling |
| `PUBLIC_BASE_URL` | _(empty)_ | Public files host (no trailing slash); when set, `render` jobs return `files[].url` download links |
| `HF_FILES_PUBLIC_PREFIX_ONLY` | _(off)_ | Optional: restrict `/files/` to `<project>/<prefix>/…` (`renders`, CSV list, or `true` = `renders`) |
| `TTS_API_BASE_URL` | _(empty)_ | Base URL of OpenAI-compatible TTS endpoint (appends `/v1/audio/speech`) |
| `TTS_API_MODEL` | _(empty)_ | TTS model identifier |
| `TTS_API_VOICE` | _(empty)_ | TTS voice identifier |
| `TTS_API_API_KEY` | _(empty)_ | Optional bearer token for TTS API |
| `TTS_API_TIMEOUT_MS` | `300000` | TTS request timeout (5 min) |
| `TTS_API_MAX_TEXT_BYTES` | `65536` | Max UTF-8 text payload for TTS (64 KB) |
| `TTS_API_MAX_AUDIO_BYTES` | `26214400` | Max generated WAV audio response size (25 MB) |
| `WHISPERX_EXECUTABLE` | `/opt/whisperx-venv/bin/whisperx` | Path to WhisperX executable |
| `WHISPERX_MODEL` | `base` | WhisperX model to use for CPU transcription |
| `WHISPERX_MODEL_CACHE_DIR` | `/data/whisperx-cache` | Directory where WhisperX persists model downloads |
| `WHISPERX_TIMEOUT_MS` | `1800000` | WhisperX transcription timeout (30 min) |
| `WHISPERX_MAX_AUDIO_BYTES` | `524288000` | Max input audio file size for transcription (500 MB) |
| `WHISPERX_MAX_JSON_BYTES` | `20971520` | Max transcript output JSON size (20 MB) |

## Development

```sh
npm install          # only needed for the MCP SDK / stdio usage
npm test             # node --test suite (no CLI/toolchain needed)
docker build -t hyperframes-mcp:latest .
```

Tests cover the render-output randomiser, public URL construction, the
`list_assets` walker, TTS-API integration, WhisperX execution, and the
`/files/` route (traversal, ranges, content types, prefix restriction).

## Notes / roadmap

- Rendering is CPU/RAM heavy → it runs through a **persistent job queue**
  (`src/jobs.js`) with capped concurrency, so the MCP request returns instantly.
- The image is large (Chrome + ffmpeg + CPU PyTorch/WhisperX + the full toolchain) and the build clones
  **our fork** of upstream (`Pantek59/hyperframes`, pinned with `HF_REF`) for
  reproducibility — the fork keeps working even if the upstream repo is removed.
- CI builds and publishes the image to GHCR (`ghcr.io/pantek59/hyperframes-mcp`)
  on every push to `main` — see `.github/workflows/docker-publish.yml`.
- Not a fork of upstream — this repo carries only the server + deployment recipe.
