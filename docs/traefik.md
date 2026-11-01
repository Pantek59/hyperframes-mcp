# Traefik setup — serving renders publicly

This recipe wires the public files host (`files.<domain>` in the examples below
— use your own) to this container. The goal:

1. The public host answers **only** `https://files.<domain>/files/{project}/renders/{file}`
   — everything else (and other paths on that host) fails closed with 404.
2. Traefik **injects the bearer token** itself, so the server accepts the
   request. The server requires the token on `/files/` too, which makes a
   missing middleware fail safe: 401, never an unauthenticated leak.
3. `/mcp`, `/jobs`, `/health`, snapshots, assets and project sources stay off
   the public host.

Two mechanisms make the URLs safe to publish without login:

- render filenames are randomised by default (`HF_RANDOMIZE_OUTPUT=true`,
  `renders/<32 hex>-<name><ext>`) — the unguessable path is the protection;
- `HF_FILES_PUBLIC_PREFIX_ONLY` (default off) can restrict the server-side
  `/files/` route to `<project>/renders/**` as a second layer. Leave it off
  when Traefik carries the restriction; enable it if you also serve files
  through other proxies.

---

## Option A — Docker labels (extends `docker-compose.yml`)

Compose interpolates `${MCP_AUTH_TOKEN}` from your `.env`, so the container and
the middleware get the same token:

```yaml
    labels:
      # ── existing routers (internal host, token-protected by the client) stay
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

      # keep render URLs out of search engines (obscurity is the protection)
      - "traefik.http.middlewares.hf-files-noindex.headers.customresponseheaders.X-Robots-Tag=noindex"

      # HTTP → HTTPS for the files host
      - "traefik.http.routers.hf-files-web.rule=Host(`files.<domain>`) && PathRegexp(`/files/[^/]+/renders/.+`)"
      - "traefik.http.routers.hf-files-web.entrypoints=web"
      - "traefik.http.routers.hf-files-web.service=hf-mcp-web"
      - "traefik.http.routers.hf-files-web.middlewares=redirect-to-https@file"
```

Details that matter:

- **`PathRegexp`, not `PathPrefix`.** A `/files/` prefix would also publish
  `<project>/snapshots/`, `<project>/assets/` and sources. The regex is
  anchored to the whole path: `/files/p/renders` (the directory itself) does
  **not** match, only real files do.
- Traefik matchers run on the **decoded** path, so encoded traversal
  (`..%2f..%2f`) also fails to match the router — an extra layer on top of the
  server's own path hardening (see `src/files.js`).
- `customRequestHeaders.Authorization` **overrides** any client-supplied
  `Authorization` on this route — fine, by design.
- No `stripPrefix` and no compression: videos stream with HTTP Range, which
  passes through unchanged.

Caveat: with labels, the resolved token is readable via `docker inspect` on
the host. If that bothers you (multi-admin box), use Option B, or move only
the token middleware into a file-provider config with a secret file.

---

## Option B — Traefik file provider (recommended with Dokploy)

Dokploy manages container labels, so a dynamic config file is the safer home
for this router. Put this under your Traefik dynamic-config directory (whatever
your static config mounts as `--providers.file.directory`, e.g.
`/etc/traefik/dynamic/hyperframes-files.yml`):

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
      middlewares: [redirect-to-https]   # must exist; else drop or define it

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
          - url: "http://hyperframes-mcp:8080"   # container name on the shared docker network
```

Notes:

- `<TOKEN>` must equal the server's `MCP_AUTH_TOKEN`. Protect the file:
  Traefik reads it from disk, so keep it root-only (chmod 600) and out of any
  repo or backup that agents/users can read.
- `redirect-to-https`: in the label variant it is referenced as
  `redirect-to-https@file` because labels (docker provider) call a middleware
  defined by the file provider. Inside a file-provider config itself, use the
  plain name if it lives in the same provider — adjust to your setup, or drop
  the router and rely on a global HTTP→HTTPS entrypoint redirect if you have
  one.
- If the container and Traefik share a docker network, `http://<container>:8080`
  works; otherwise publish the container port on localhost only
  (`127.0.0.1:8080:8080`) and point the file provider at that.

---

## What stays off the public host

| Path | Visibility |
|---|---|
| `/files/{p}/renders/{file}` | public (Traefik-injected token, unguessable names) |
| `/files/{p}/snapshots/…`, `/assets/…`, sources | server-internal (router regex 404s them first) |
| `POST /mcp` | internal; LibreChat connects over the docker network (`http://hyperframes-mcp:8080/mcp`) or another **token-protected** host — clients send their own `Authorization` header, do not reuse the injection middleware there |
| `GET /jobs`, `/jobs/<id>`, `/health` | internal only |

## Failure modes

| Breakage | Effect |
|---|---|
| Token middleware missing or stale | server answers **401** — public leak impossible, only broken downloads |
| Regex loosened to a `/files/` prefix | snapshots/sources/assets become public — **the dangerous one**, hence the tests below |
| DNS set but router missing | 404 from Traefik (fail-closed) |
| `PUBLIC_BASE_URL` in `.env` not matching this host | job results carry `url`s that 404 — fix the env, redeploy |

## Verify after deploying

```sh
# expect: 200, video/mp4, accept-ranges (use a real URL from a job result)
curl -sI "https://files.<domain>/files/kinetic-type/renders/<token>-demo.mp4"

# expect: 206 with content-range
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Range: bytes=0-99" \
  "https://files.<domain>/files/kinetic-type/renders/<token>-demo.mp4"

# expect: 404 for ALL of these — the router must refuse them
curl -sI "https://files.<domain>/files/kinetic-type/snapshots/shot_1.png"
curl -sI "https://files.<domain>/files/kinetic-type/assets/logo.png"
curl -sI "https://files.<domain>/mcp"
curl -sI "https://files.<domain>/health"
```

Rotate the token (`MCP_AUTH_TOKEN` accepts a comma-separated list ⇒ zero-downtime
rotation) and remember that the token lives wherever the middleware does —
compose `.env` (Option A) or the Traefik dynamic file (Option B).
