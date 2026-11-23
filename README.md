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
| `tts_generate` | Reads a UTF-8 text file from `assets/` and generates a WAV asset via the configured OpenAI-compatible TTS-API (`voice` per call optional; evicted clones re-register automatically) |
| `tts_upload_voice` | Voice cloning: registers a reference audio sample (from any project's `assets/`, or a file dropped directly into the global voice store root/`inbox/`) as a reusable `voice` — **one registry for both TTS backends**; consent required, `ref_text` (exact transcript) **required**. Samples + metadata live **globally** in `HF_VOICES_DIR` — never inside a project |
| `list_voices` | Lists available voices (default + clones with upstream-availability and `fishReady` flags, plus unregistered `inbox/` drops waiting for registration) |
| `tts_delete_voice` | Permanently removes a cloned voice (upstream + global store); `default` is protected |
| `fish_audio_tts` | Enqueues TTS: text asset → FLAC (Fish Audio S2 voice cloning on ComfyUI). Reference voice via a registered `voice` (global store) or a raw `reference_filename` + `reference_text` pair |
| `HiggsAudio_TTS` | Reports whether the Higgs/TTS-API backend (behind `tts_generate` and voice registration) is reachable: GET `/v1/audio/voices` (5 s), `base_url`, latency, configured model/voice, local queue |
| `comfyui_status` | Reports whether the ComfyUI TTS backend is running and reachable (version, GPU, queue load) |
| `share_asset` | Copies an asset into `renders/` with an unguessable name and returns the token-free public download URL |
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

- **`tts_generate`:** Reads UTF-8 text from `<project>/assets/...` and calls a configured OpenAI-compatible TTS endpoint (`/v1/audio/speech`). Generates a `.wav` file saved directly next to the input file in `assets/`. An optional per-call `voice` parameter overrides the server default (`TTS_API_VOICE`) — e.g. a cloned voice.
- **`tts_upload_voice` (voice cloning):** Uploads an audio sample from `<project>/assets/...` (or dropped directly into the global voice store's root/`inbox/`) as a reference to the TTS voices endpoint (`POST /v1/audio/voices`, multipart) and registers it under a `name`. **The registry is shared by both TTS backends:** Higgs/TTS-API uses the voice by `name`, and Fish Audio S2 (ComfyUI) clones per job from the stored sample + transcript. Therefore `ref_text` (the exact transcript) is **required**, plus an optional 2–3 letter `language` used as the Fish default. The upstream API **requires a `consent` statement** — only clone voices you are authorized to use (your own, or with the speaker's explicit permission). Confirm registration with `list_voices`. Sample size is capped by `TTS_API_MAX_SAMPLE_BYTES` (default 25 MB).
- **`list_voices`:** Lists the available voices (`default` + registered clones with `availableUpstream` and `fishReady` flags) — use it to pick the `voice` for `tts_generate` and `fish_audio_tts`. When the upstream is unreachable it fails with a diagnosable message that carries the configured origin and the OS cause code (e.g. `TTS voices API (http://10.10.10.68:8000) request failed: fetch failed (ECONNREFUSED)`).
- **`HiggsAudio_TTS`:** Probes the Higgs/TTS-API backend from inside the server (`GET /v1/audio/voices`, 5 s timeout) and reports `reachable` / `base_url` / `latency_ms` / configured `model` + `voice` / local queue. Counterpart of `comfyui_status` for the primary backend — never itself an error, on outage it returns `reachable: false` with the cause code (e.g. `ECONNREFUSED`).
- **Backend independence:** `tts_generate` and new voice registrations (`tts_upload_voice`) need the Higgs/TTS-API; `fish_audio_tts` needs ComfyUI. If one backend is down (check `HiggsAudio_TTS` / `comfyui_status`), the other stays usable — already-stored clones keep working for `fish_audio_tts`, while `tts_upload_voice` (upstream registration happens first) is unavailable until Higgs is back.
- **`share_asset`:** Copies a file from `assets/` into the project's `renders/` folder under an unguessable random name and returns the token-free public download URL (when `PUBLIC_BASE_URL` is set). Use this whenever a user needs to *click* a link to a file — browsers cannot send `Authorization` headers, and only `renders/**` is served publicly.
- **`whisperx_transcribe`:** Runs WhisperX locally on CPU against an audio file under `<project>/assets/...`. Saves a timed JSON transcript with word- and segment-level timestamps next to the original asset. Models are downloaded on first use and cached persistently (`WHISPERX_MODEL_CACHE_DIR`).

### Second TTS provider (Fish Audio on ComfyUI)

Besides the primary `tts_generate` (OpenAI-compatible TTS-API), a **`fish_audio_tts`**
tool voice-clones the narration through a ComfyUI workflow (Fish Audio S2) and
publishes the result as FLAC. It enqueues like the other heavy jobs and resolves the
reference in one of two modes:

- **Registered voice (preferred): `voice=<name>`** — the sample and its exact
  transcript come straight from the global voice store (`HF_VOICES_DIR`), the same
  registry `tts_generate` uses. No reference assets in the project needed; only
  voices with a transcript (`fishReady`) qualify. Per-call `language` wins over
  the language stored at registration, which wins over `FISH_AUDIO_LANGUAGE`.
- **Ad-hoc pair:** `reference_filename` (a recording of the target speaker under
  `assets/`) plus `reference_text` (the exact transcript of that recording).

Call `comfyui_status` first to check that the ComfyUI backend (`COMFYUI_BASE_URL`)
is running and idle before enqueuing. Note: the reference is uploaded into
ComfyUI's `input/` per job and is not cleaned up afterwards (ComfyUI offers no
delete endpoint) — harmless, but worth knowing.

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

#### Serving renders publicly

The intended reverse-proxy setup exposes **only** the renders (e.g. at
`https://files.<domain>/files/{project}/renders/{file}`) without authentication
and fails closed (404) for everything else — `/mcp`, `/jobs`, `/health`,
snapshots, assets, and project sources stay internal.

**How it works:**
1. **Public host answers only renders:** The reverse proxy strictly routes
   `https://files.<domain>/files/{project}/renders/{file}`. All other paths fail
   closed with 404.
2. **Reverse proxy injects bearer token:** The proxy injects the `Authorization: Bearer ${MCP_AUTH_TOKEN}`
   header into upstream requests so the server accepts them. If the middleware
   is missing or misconfigured, the server fails safe with a 401 response (never
   an unauthenticated leak).
3. **Unguessable filenames:** With `HF_RANDOMIZE_OUTPUT=true` (default), render
   filenames are prefixed with 32 random hex characters (`renders/<token>-<name><ext>`).
4. **No search indexing:** The proxy adds `X-Robots-Tag: noindex` response headers.
5. **Streaming / Range requests:** HTTP Range requests pass through untouched
   for video seeking (do not apply compression or strip prefixes).

Related environment variables:
- `PUBLIC_BASE_URL` — set to your public files host (e.g. `https://files.<domain>`).
  When set, `render_video` / `get_job` return `files[].url` download links.
- `HF_FILES_PUBLIC_PREFIX_ONLY` — optional server-side defense in depth: restrict
  `/files/` to `<project>/renders/**`. Default is off (leave off when the reverse
  proxy carries the restriction; enable if serving via multiple proxies).

---

##### 1. Traefik

###### Option A — Docker labels (extends `docker-compose.yml`)

Compose interpolates `${MCP_AUTH_TOKEN}` from your `.env`:

```yaml
    labels:
      - traefik.enable=true
      - traefik.docker.network=dokploy-network

      # ── public files host: renders only ────────────────────────────
      - "traefik.http.routers.hf-files.rule=Host(`files.<domain>`) && PathRegexp(`/files/[^/]+/renders/.+`)"
      - "traefik.http.routers.hf-files.entrypoints=websecure"
      - "traefik.http.routers.hf-files.service=hf-mcp-websecure"
      - "traefik.http.routers.hf-files.tls.certresolver=letsencrypt"
      - "traefik.http.routers.hf-files.middlewares=hf-files-token,hf-files-noindex"

      # proxy injects the same bearer token the server requires
      - "traefik.http.middlewares.hf-files-token.headers.customrequestheaders.Authorization=Bearer ${MCP_AUTH_TOKEN}"

      # keep render URLs out of search engines
      - "traefik.http.middlewares.hf-files-noindex.headers.customresponseheaders.X-Robots-Tag=noindex"

      # HTTP → HTTPS for the files host
      - "traefik.http.routers.hf-files-web.rule=Host(`files.<domain>`) && PathRegexp(`/files/[^/]+/renders/.+`)"
      - "traefik.http.routers.hf-files-web.entrypoints=web"
      - "traefik.http.routers.hf-files-web.service=hf-mcp-web"
      - "traefik.http.routers.hf-files-web.middlewares=redirect-to-https@file"
```

> **Note on `PathRegexp`:** Use `PathRegexp`, not `PathPrefix`. A `/files/` prefix
> would also expose snapshots, assets, and project sources.

###### Option B — Dynamic file provider (recommended with Dokploy)

Save under your Traefik dynamic configuration directory (e.g. `/etc/traefik/dynamic/hyperframes-files.yml`):

```yaml
http:
  routers:
    hf-files:
      rule: "Host(`files.<domain>`) && PathRegexp(`/files/[^/]+/renders/.+`)"
      entryPoints: [websecure]
      service: hyperframes-mcp
      tls:
        certResolver: letsencrypt
      middlewares: [hf-files-token, hf-files-noindex]

    hf-files-web:
      rule: "Host(`files.<domain>`) && PathRegexp(`/files/[^/]+/renders/.+`)"
      entryPoints: [web]
      service: hyperframes-mcp
      middlewares: [redirect-to-https]

  middlewares:
    hf-files-token:
      headers:
        customRequestHeaders:
          Authorization: "Bearer <TOKEN>"   # same value as MCP_AUTH_TOKEN
    hf-files-noindex:
      headers:
        customResponseHeaders:
          X-Robots-Tag: noindex

  services:
    hyperframes-mcp:
      loadBalancer:
        servers:
          - url: "http://hyperframes-mcp:8080"   # container name on shared docker network
```

---

##### 2. Caddy

In your `Caddyfile`:

```caddy
files.<domain> {
    # Match ONLY files under /files/{project}/renders/{file}
    @renders path_regexp renders ^/files/[^/]+/renders/.+$

    handle @renders {
        header X-Robots-Tag noindex
        reverse_proxy hyperframes-mcp:8080 {
            header_up Authorization "Bearer {$MCP_AUTH_TOKEN}"
        }
    }

    # Everything else fails closed with 404
    handle {
        respond 404
    }
}
```

---

##### 3. jwilder/nginx-proxy

When using [`jwilder/nginx-proxy`](https://github.com/nginx-proxy/nginx-proxy), configure custom location rules by mounting a vhost file at `/etc/nginx/vhost.d/files.<domain>`:

```nginx
# /etc/nginx/vhost.d/files.<domain>

# Match ONLY render files
location ~ ^/files/[^/]+/renders/.+$ {
    proxy_pass http://hyperframes-mcp:8080;
    proxy_set_header Authorization "Bearer YOUR_MCP_AUTH_TOKEN";
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $proxy_x_forwarded_proto;

    # Prevent search engine indexing
    add_header X-Robots-Tag "noindex" always;

    # HTTP range requests / video streaming
    proxy_http_version 1.1;
    proxy_set_header Connection "";
}

# Fail closed for all other paths on the public files domain
location / {
    return 404;
}
```

In your `docker-compose.yml`:

```yaml
services:
  hyperframes-mcp:
    image: ghcr.io/pantek59/hyperframes-mcp:latest
    environment:
      - VIRTUAL_HOST=files.<domain>
      - VIRTUAL_PORT=8080
      - LETSENCRYPT_HOST=files.<domain>
      - MCP_AUTH_TOKEN=${MCP_AUTH_TOKEN}
      - PUBLIC_BASE_URL=https://files.<domain>
    volumes:
      - ./vhost.d/files.<domain>:/etc/nginx/vhost.d/files.<domain>:ro
```

---

##### Verification after deploying

```sh
# Expect: 200, video/mp4, accept-ranges (use a real URL from a job result)
curl -sI "https://files.<domain>/files/kinetic-type/renders/<token>-demo.mp4"

# Expect: 206 with content-range (streaming support)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Range: bytes=0-99" \
  "https://files.<domain>/files/kinetic-type/renders/<token>-demo.mp4"

# Expect: 404 for ALL of these — the router must refuse them
curl -sI "https://files.<domain>/files/kinetic-type/snapshots/shot_1.png"
curl -sI "https://files.<domain>/files/kinetic-type/assets/logo.png"
curl -sI "https://files.<domain>/mcp"
curl -sI "https://files.<domain>/health"
```

## Env

| Var | Default | Meaning |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `8080` | HTTP port |
| `MCP_AUTH_TOKEN` | _(empty)_ | If set, require `Authorization: Bearer *** (CSV = rotation). `/health` stays public |
| `HF_WORKSPACE` | `/data/projects` | Where projects live |
| `HF_JOBS_DIR` | `/data/jobs` | Where job records are persisted |
| `HF_VOICES_DIR` | `/data/voices` | Global voice store for clones (`registry.json` + `samples/`) — outside the workspace, never served by `/files/` |
| `HF_JOB_CONCURRENCY` | `1` | Max renders/snapshots running at once |
| `HF_JOB_TAIL_LINES` | `200` | Log lines kept per job |
| `HF_WAIT_MAX_MS` | `600000` | Cap for `wait:true` / `wait_job` |
| `HF_ROOT` / `HF_CLI` | `/app/hf` | Upstream checkout / CLI entry |
| `HF_RENDER_TIMEOUT_MS` | `1800000` | Render timeout (30 min) |
| `HF_RANDOMIZE_OUTPUT` | `true` | Random unguessable `renders/<token>-<name>.mp4` outputs; `false` restores legacy `-o` handling |
| `COMFYUI_BASE_URL` / `COMFYUI_API_KEY` | _(empty)_ | ComfyUI server used by `fish_audio_tts` and `comfyui_status` (API key optional, for proxies) |
| `FISH_AUDIO_TIMEOUT_MS` | `900000` | Fish Audio TTS job timeout — keep generous, the first job downloads the model |
| `FISH_AUDIO_LANGUAGE` | `de` | Default language for `fish_audio_tts` (per-call `language` wins) |
| `FISH_AUDIO_MODEL_PATH` / `FISH_AUDIO_WORKFLOW_JSON` | _(empty)_ | Optional: override the Fish node's `model_path` widget / replace the built-in workflow (API-format JSON with a Fish TTS + LoadAudio node) |
| `PUBLIC_BASE_URL` | _(empty)_ | Public files host (no trailing slash); when set, `render` jobs return `files[].url` download links |
| `HF_FILES_PUBLIC_PREFIX_ONLY` | _(off)_ | Optional: restrict `/files/` to `<project>/<prefix>/…` (`renders`, CSV list, or `true` = `renders`) |
| `TTS_API_BASE_URL` | _(empty)_ | Base URL of OpenAI-compatible TTS endpoint (appends `/v1/audio/speech`); probe with `HiggsAudio_TTS` |
| `TTS_API_MODEL` | _(empty)_ | TTS model identifier |
| `TTS_API_VOICE` | _(empty)_ | TTS voice identifier |
| `TTS_API_API_KEY` | _(empty)_ | Optional bearer token for TTS API |
| `TTS_API_TIMEOUT_MS` | `300000` | TTS request timeout (5 min) |
| `TTS_API_LIST_TIMEOUT_MS` | `10000` | Timeout for the `list_voices` upstream fetch (`GET /v1/audio/voices`) |
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
- The image is large (Chrome + ffmpeg + CPU PyTorch/WhisperX + the full toolchain) and the build clones the
  **public upstream** (`heygen-com/hyperframes`, pinned with `HF_REF`) for
  reproducibility — builds stay deterministic as long as that commit exists.
- CI builds and publishes the image to GHCR (`ghcr.io/pantek59/hyperframes-mcp`)
  on every push to `main` — see `.github/workflows/docker-publish.yml`.
- Not a fork of upstream — this repo carries only the server + deployment recipe.
