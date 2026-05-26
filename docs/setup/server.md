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

There is currently **no built-in base-path / prefix support**. If you need Horizon under `/horizon/` rather than `/`, terminate the prefix at your reverse proxy and rewrite paths there. The UI assumes it is served from the root.
