# Server Listener

HTTP listener for the Horizon BFF. Also serves the built UI as static assets when `staticDir` is set.

```yaml
server:
  host: 127.0.0.1
  port: 8081
  staticDir: /opt/horizon/ui/dist     # optional
```

## Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `host` | string | `127.0.0.1` | no | Interface to bind. Set `0.0.0.0` to listen on all interfaces (production behind TLS terminator). |
| `port` | number | `8081` | no | TCP port. Must be a positive integer. |
| `staticDir` | string | — | no | Filesystem path to a directory of pre-built UI assets. When set and the directory exists, the BFF serves files from this directory with SPA-style fallback: any 404 returns `index.html` so client-side routing works. When unset, the BFF only serves API routes (`/api/*`) — useful for running the UI dev server separately. |

## Common shapes

### Dev (UI and BFF separate)

```yaml
server:
  host: 127.0.0.1
  port: 8081
```

Run `pnpm --filter ui dev` separately. The Vite dev server listens on port 9091 and proxies `/api/*` to the BFF.

### Production (single port)

```yaml
server:
  host: 0.0.0.0
  port: 8081
  staticDir: /opt/horizon/ui/dist
session:
  cookieSecure: true
```

Browser hits a TLS terminator → BFF on port 8081. The BFF serves UI bundles and API routes from the same origin (no CORS gymnastics, no extra reverse proxy).

### Behind a path prefix

Horizon can be served under a path prefix such as `/horizon/`, but the prefix is **baked into the UI at build time** — it is not a `horizon.yaml` field and cannot be changed on a running server. Two things have to agree: the artifact is built for the prefix, and the reverse proxy strips the prefix before forwarding. Horizon itself always answers at the root.

The published container image and binary tarball are built for `/`, so a prefixed deployment means producing the artifact yourself. Set `HORIZON_UI_BASE` on the [source build](overview.md#source-build):

```sh
HORIZON_UI_BASE=/horizon/ pnpm package
```

Every page URL, static asset, and API call in that build then resolves under `/horizon/`. The variable is read by the source build only — `docker build` does not pass it into its build stage, so the prefixed artifact is the `pnpm package` output, run directly or copied into an image of your own.

Then strip the prefix at the proxy — with nginx, the trailing slash on `proxy_pass` is what does it:

```nginx
location /horizon/ {
    proxy_pass http://127.0.0.1:8081/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Getting one half without the other shows up as a blank page in both directions:

- **Built for the prefix, but the proxy forwards it unchanged** — Horizon serves from the root, so `/horizon/assets/…` matches no file and comes back as the SPA fallback `index.html` instead of the asset.

- **Proxy strips it, but the build is the default root one** — the page loads, then asks for its assets and API at `/…`, which is outside the `/horizon/` location and never reaches Horizon.

If you front the assistant's chat stream through the same proxy, also see the buffering note in [AI Assistant](../operate/ai-assistant.md).
