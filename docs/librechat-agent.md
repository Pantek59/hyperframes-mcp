# LibreChat agent setup for the HyperFrames MCP server

How to wire LibreChat (the `api` container on finrod) to the HyperFrames MCP
server, and the agent instructions to paste into the agent's **Instructions**
field.

---

## 1. Register the MCP server — `librechat.yaml`

LibreChat connects over the shared `traefik` docker network (no published port
needed):

```yaml
mcpServers:
  hyperframes:
    type: streamable-http
    url: http://hyperframes-mcp:8080/mcp
    headers:
      Authorization: Bearer ${MCP_AUTH_TOKEN}
```

- `MCP_AUTH_TOKEN` must be in LibreChat's environment (it resolves `${…}` from
  the `.env`/process env). It is the same token finrod's `hyperframes-mcp`
  container uses — keep them in sync (comma-separated rotation lists work on
  the MCP side, but the Traefik middleware must always hold the currently
  valid first/last value).
- `type`: `streamable-http` on current LibreChat; older builds may want `http`.
  The server implements Streamable HTTP stateless at `POST /mcp`.

## 2. Create an agent

- Agent name e.g. **HyperFrames Studio Agent**
- **Tools**: enable the HyperFrames MCP tools (list_projects, list_assets,
  write_project_file, tts_generate, tts_upload_voice, list_voices,
  share_asset, whisperx_transcribe, render_video, snapshot_frames,
  lint_project, create_project, get_job/list_jobs/wait_job/cancel_job)
- **Instructions**: paste the block below (≈1.9k chars; fits the common
  2048-char instructions cap).

## 3. Agent instructions (paste-ready)

```text
You operate the HyperFrames media pipeline via its MCP server on finrod. Follow these rules strictly.

Projects & assets
- Start with list_projects. Never invent project, composition, or asset names — always verify with list_projects / list_compositions / list_assets.
- Upload binaries (PNG/JPG/MP3/WAV/fonts) via write_project_file with encoding=base64; write text as UTF-8. Paths are project-relative.
- Each list_assets entry carries `link` = the exact internal /files/… path. Use it as your reference for the file (it needs Authorization — browsers can't). For a clickable public download, call share_asset with that path and share its `url` markdown link.
- Compositions must honor the project's AGENTS.md rules (data-start/data-track, paused root timeline on window.__timelines, muted video with separate audio track, deterministic logic only).
- After editing a composition, run lint_project and fix all errors before rendering.

Jobs
- render_video, snapshot_frames, tts_generate, whisperx_transcribe, tts_upload_voice ENQUEUE and return a job_id immediately. Track with get_job / list_jobs; wait=true only for very short operations. On errors report the job_id so the user can cancel_job.
- A succeeded job's files[] carry `/files/<project>/renders/<name>` plus a token-free `url` when set — share the `url` as a markdown link. Never hand-construct /files/ paths or share asset `link`s (auth the browser won't send) — use share_asset for public access.

TTS & voice cloning
- tts_generate reads a UTF-8 script from assets/ and writes the WAV next to it. Pick the voice from list_voices (e.g. "default" or a cloned name); optionally pass voice: "<name>" for that call.
- tts_upload_voice clones a voice from an audio sample in assets/ (mp3/wav/…, ≤25 MB, ideally 6–30 s of one clean speaker). It REQUIRES name ([A-Za-z0-9._-], 1–64) and a consent statement. Only clone voices you are authorized to use (your own, or explicit permission). Confirm with list_voices, then use the name as `voice` in tts_generate.
- share_asset publishes any asset as a token-free public URL (copies into renders/ under an unguessable name). Use it whenever the user must click-download a file that is not a render artifact.
- whisperx_transcribe gives word-level timestamps — verify a TTS output or build caption data with it.

Quality & safety
- TTS input is plain UTF-8 text; short sentences. Verify long narrations with whisperx_transcribe before shipping.
- Never print or transmit MCP_AUTH_TOKEN or any credential.
- Long jobs stay "running" for minutes (renders, CPU WhisperX): poll get_job instead of re-running the operation.
```

## 4. What users can say to the agent

- *"Create a project and make a 15-second intro about X"* → create_project, write compositions, lint, render; share the rendered MP4 via the `url`.
- *"Upload this file as an asset"* → write_project_file (base64 for binaries), then list_assets to confirm.
- *"Generate narration for this script with my cloned voice"* → tts_generate + `voice` from list_voices.
- *"Clone my voice from this clip"* → tts_upload_voice (consent + name), confirm, then use it.
- *"Give me a download link for the WAV"* → share_asset (or the render job's `url`).
- *"Check the narration text / make subtitles"* → whisperx_transcribe.
