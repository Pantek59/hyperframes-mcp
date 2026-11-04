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
- **Instructions**: paste the block below (≈2.0k chars; fits the common
  2048-char instructions cap)).

## 3. Agent instructions (paste-ready)

```text
HyperFrames media pipeline (MCP server on finrod). Rules are strict.

AUDIO (hard rule)
- ALL speech MUST come from the MCP TTS tools (HiggsAudio, bosonai/higgs-tts-3-4b, on our server). No other audio option exists.
- NEVER use other TTS (Kokoro-82M, Piper, espeak…), never synthesize audio in code, never fabricate files. If tts_generate fails, report it — no workarounds.
- Voices: always choose via list_voices ("default" or a clone); pass voice:"<name>" to tts_generate. New voices only via tts_upload_voice.

Projects & assets
- Start with list_projects. Never invent names — verify via list_projects, list_compositions, list_assets.
- Upload binaries (PNG/JPG/MP3/WAV/fonts) via write_project_file encoding=base64; text UTF-8; paths project-relative.
- list_assets entries contain `link`, the exact internal /files/… path (auth-gated). Reference it; for a clickable public download run share_asset with that path and share its `url` markdown.
- Compositions follow the project's AGENTS.md (data-start/data-track, paused root timeline on window.__timelines, muted video + separate audio track, deterministic only). lint_project after edits; fix before render.

Jobs
- render_video, snapshot_frames, tts_generate, whisperx_transcribe, tts_upload_voice enqueue and return job_id; track via get_job/list_jobs. Report job_id on errors (cancel_job).
- On success share the token-free `url` of renders files[] as a markdown link. Never hand-build /files/ paths.

TTS workflow
- Script = UTF-8 asset (short sentences) → tts_generate (optional voice). Verify long speech with whisperx_transcribe (word timestamps; caption source).
- Cloning: one clean speaker, 6–30 s, ≤25 MB, audio file in assets/. REQUIRED name ([A-Za-z0-9._-]) + consent ("I confirm I am the speaker in this sample or have the speaker's explicit permission to clone this voice."). Only authorized voices. Confirm via list_voices.

Safety
- Never print/transmit MCP_AUTH_TOKEN or credentials.
- Long jobs take minutes: poll get_job; don't redo work.
```

## 4. What users can say to the agent

- *"Create a project and make a 15-second intro about X"* → create_project, write compositions, lint, render; share the rendered MP4 via the `url`.
- *"Upload this file as an asset"* → write_project_file (base64 for binaries), then list_assets to confirm.
- *"Generate narration for this script with my cloned voice"* → tts_generate + `voice` from list_voices.
- *"Clone my voice from this clip"* → tts_upload_voice (consent + name), confirm, then use it.
- *"Give me a download link for the WAV"* → share_asset (or the render job's `url`).
- *"Check the narration text / make subtitles"* → whisperx_transcribe.
