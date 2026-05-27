---
name: local-boot
description: Boot the Horizon UI dev env (BFF + UI) against a local OAP or the public Apache demo OAP, using the static configs bundled with this skill. Handles the apps/bff cwd / HORIZON_CONFIG gotcha and the demo OAP password (kept out of git via ${OAP_PASSWORD}).
user-invocable: true
---

# Boot the Horizon UI local dev env

Two bundled static configs live next to this file:

- `horizon.local.yaml` — no-auth OAP. Defaults to `127.0.0.1:12800`, but the OAP URLs are env-overridable (see "Custom OAP target" below) so the same file boots against any no-auth OAP (remote dev cluster, deliberately-unreachable port for the landing-block preview, etc.).
- `horizon.demo.yaml` — public Apache demo OAP, OAP password read from `${OAP_PASSWORD}`.

Both define the same throwaway Horizon login users (password == username):
`viewer`, `maintainer`, `operator`, `admin`.

The stack: **BFF** (Fastify) on `:8081`, **UI** (Vite) on `:9091` proxying `/api` → `:8081`. Open **`http://127.0.0.1:9091`** (use the IPv4 literal, not `localhost` — see the proxy/IPv4 section).

Both ports are overridable — see "Custom ports" below. The defaults are what the examples use throughout this doc.

## Environment variables (the dev contract)

Local dev runs as **two processes / two ports**: the BFF (Fastify, owns
`/api`) and Vite (serves the UI, proxies `/api` → BFF). They coordinate
through env vars below. The BFF reads them via the YAML loader's
`${VAR:default}` interpolation; Vite reads `BFF_PORT` + `UI_DEV_PORT`
directly in `apps/ui/vite.config.ts`. Set them on **both** processes
when overriding (or the proxy points at the wrong BFF).

| Variable          | Default                          | Used by  | Purpose |
|---|---|---|---|
| `HORIZON_CONFIG`  | _(none — required)_              | BFF      | **Absolute** path to the yaml config. A bare `./horizon.yaml` resolves under `apps/bff/` and silently boots with zero users — see "The one gotcha" below. |
| `BFF_PORT`        | `8081`                           | BFF + UI | BFF listen port (yaml `server.port`) AND Vite's proxy target. Set the same value on both. Prod uses this as the single port (BFF serves the built UI). |
| `UI_DEV_PORT`     | `9091`                           | UI       | Vite listen port. Dev-only — meaningless in prod. |
| `OAP_QUERY_URL`   | `http://localhost:12800`         | BFF      | OAP GraphQL endpoint (applies to `horizon.local.yaml`). |
| `OAP_ADMIN_URL`   | `http://localhost:12800`         | BFF      | OAP admin REST endpoint. Often differs from GraphQL on real deployments (e.g. demo splits on `:17128`) — if BFF logs `UITemplate 404`, override this. |
| `OAP_ZIPKIN_URL`  | `http://localhost:9412/zipkin`   | BFF      | Zipkin query endpoint (Zipkin trace layer). |
| `OAP_TIMEOUT_MS`  | `15000`                          | BFF      | OAP request timeout. Lower it (`5000`) when previewing the "OAP unreachable" landing block so errors surface fast. |
| `OAP_PASSWORD`    | _(none)_                         | BFF      | Demo OAP basic-auth password (`horizon.demo.yaml` only). Cached at `oap-password.local` (git-ignored). |
| `LDAP_BIND_PW`    | `admin` _(test value)_           | BFF      | LDAP service-bind password (`horizon.ldap.yaml` only). Set a real value before pointing at a real directory. |

Minimal local dev (defaults, no overrides):

```bash
REPO="$(git rev-parse --show-toplevel)"
HORIZON_CONFIG="$REPO/.claude/skills/local-boot/horizon.local.yaml" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &           # → :8081
( cd "$REPO/apps/ui" && node_modules/.bin/vite --host 127.0.0.1 & ) # → :9091
```

Custom ports for a parallel env (e.g. coexist with booster-ui on 8080):

```bash
BFF_PORT=10081 UI_DEV_PORT=10091 \
  HORIZON_CONFIG="$REPO/.claude/skills/local-boot/horizon.local.yaml" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &
( cd "$REPO/apps/ui" && BFF_PORT=10081 UI_DEV_PORT=10091 \
    node_modules/.bin/vite --host 127.0.0.1 & )
```

Remote OAP (no auth) via env override:

```bash
OAP_QUERY_URL=http://oap.dev.example:12800 \
OAP_ADMIN_URL=http://oap.dev.example:17128 \
HORIZON_CONFIG="$REPO/.claude/skills/local-boot/horizon.local.yaml" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &
```

The longer "Custom ports" and "Custom OAP target" sections below cover
the prod single-port model, the GraphQL/admin port split, and the
unreachable-OAP preview.

## The one gotcha that bites every time

The BFF dev script is `tsx watch src/server.ts` and pnpm runs it with **cwd = `apps/bff`**. The config path is `process.env.HORIZON_CONFIG ?? './horizon.yaml'`, resolved relative to cwd — so a bare `./horizon.yaml` points at the non-existent `apps/bff/horizon.yaml`, and the loader silently falls back to **defaults with zero users** (every login then fails with "invalid credentials", and the boot log warns `auth.local.users is empty`).

**Always pass `HORIZON_CONFIG` as an ABSOLUTE path.** Use `"$REPO/.claude/skills/local-boot/<file>"`.

## Proxy + IPv4 (the second gotcha)

Two things make the UI look "not accessible" even when Vite is running:

- **Vite binds IPv6 `[::1]` by default**, so `127.0.0.1:9091` (IPv4) has nothing and many browsers / curl fail. **Force IPv4** with `--host 127.0.0.1`. Note `pnpm --filter ui run dev -- --host …` does NOT forward the flag — run the Vite binary directly (`apps/ui/node_modules/.bin/vite --host 127.0.0.1`).
- **A local proxy** (ClashX / v2ray etc. — `http_proxy` / `https_proxy` / `all_proxy` pointing at `127.0.0.1:<port>`) intercepts loopback and returns `502`. Detect and bypass it for the dev hosts.

Detect a local proxy before booting:
```bash
env | grep -iE '^(http_proxy|https_proxy|all_proxy)=' && echo "local proxy detected — will bypass loopback"
```

The browser uses its OWN proxy settings (not the shell's), so the developer must also let `127.0.0.1` / `localhost` go direct (ClashX "bypass localhost" / system proxy no-proxy list). The env-level bypass below only fixes CLI tools and Vite's own fetches.

## Custom ports (two parallel envs, prod single-port)

The defaults are BFF `:8081` and UI `:9091`. To run a second Horizon
side-by-side (e.g. comparing two OAPs, or coexisting with the legacy
booster-ui on 8080) override with two env vars **at boot time**:

- `BFF_PORT` — the Fastify listen port. Read by the BFF yaml as
  `port: ${BFF_PORT:8081}` (interpolated by the loader before parse) AND
  by Vite's dev server when building the `/api` proxy target. **Set the
  same value on both processes** or the proxy points at the wrong BFF.
- `UI_DEV_PORT` — the Vite listen port. Dev-only, read by
  `apps/ui/vite.config.ts`.

```bash
# parallel env on 10081/10091 (e.g. against a second OAP):
BFF_PORT=10081 UI_DEV_PORT=10091 \
  HORIZON_CONFIG="$REPO/.claude/skills/local-boot/horizon.<file>.yaml" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &
( cd "$REPO/apps/ui" && BFF_PORT=10081 UI_DEV_PORT=10091 \
    env -u http_proxy -u https_proxy -u all_proxy ... \
        node_modules/.bin/vite --host 127.0.0.1 & )
```

The recipes below all use `${BFF_PORT:-8081}` / `${UI_DEV_PORT:-9091}`
shell expansions, so they pick up an override that's already exported
(or just use the defaults if not).

**Prod is single-port.** The BFF serves the built UI as static files via
`@fastify/static`, so `UI_DEV_PORT` is meaningless outside Vite. In prod
only `server.port` (i.e. `BFF_PORT`) matters.

## Custom OAP target (point horizon.local.yaml at any no-auth OAP)

`horizon.local.yaml` is the canonical no-auth config — there are no
separate `horizon.remote.yaml` / `horizon.unreachable.yaml` files
anymore. The four OAP fields all accept env-var overrides via the
loader's `${VAR:default}` syntax, so the same config boots against:

- **A LOCAL OAP** (default). No env vars needed.
- **A REMOTE OAP** — `OAP_QUERY_URL` + `OAP_ADMIN_URL` + `OAP_ZIPKIN_URL`.
- **A deliberately-unreachable port** — to preview the "OAP query host
  unreachable" landing block. Pair with a short `OAP_TIMEOUT_MS` so
  errors surface fast.

Heads-up: many real deployments split the GraphQL surface (12800) and
the admin REST surface (often 17128 — same split as the public demo).
If the BFF startup log warns `UITemplate 404` on `/ui-management/...`,
the admin URL is wrong — override `OAP_ADMIN_URL` separately.

```bash
# Remote OAP (GraphQL 12800, admin REST split on 17128):
OAP_QUERY_URL=http://oap.dev.example:12800 \
OAP_ADMIN_URL=http://oap.dev.example:17128 \
HORIZON_CONFIG="$REPO/.claude/skills/local-boot/horizon.local.yaml" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &

# Unreachable-OAP landing-block preview:
OAP_QUERY_URL=http://127.0.0.1:12801 \
OAP_ADMIN_URL=http://127.0.0.1:12801 \
OAP_TIMEOUT_MS=5000 \
HORIZON_CONFIG="$REPO/.claude/skills/local-boot/horizon.local.yaml" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &
```

## The stale-process trap (why a config switch "didn't take")

`tsx watch` keeps the old BFF alive, so a freshly launched BFF with a NEW config silently dies on `EADDRINUSE: 127.0.0.1:${BFF_PORT:-8081}` while the OLD process keeps serving the OLD OAP. Symptom: you switch local↔demo, everything looks fine, but the UI still shows the previous OAP's data.

Killing matters in two ways:
- `pkill -f "tsx watch src/server.ts"` may miss the actual listener — also `pkill -f "tsx/dist/cli.mjs watch"`, and **verify the port is actually free with `lsof` before relaunching** (loop until free; the watcher can respawn a child).
- After boot, **confirm which OAP the LIVE process is using** — don't trust that your new process won the port. The authoritative check:
  ```bash
  curl -s --noproxy '*' -b /tmp/sw.cookies "http://127.0.0.1:${BFF_PORT:-8081}/api/oap/config" | grep -oE '"adminUrl":"[^"]*"'
  # local => http://localhost:12800 ; demo => https://demo.skywalking.apache.org:17128
  ```
  Also grep the boot log for `EADDRINUSE` and the `configPath` line. If the adminUrl is wrong, a stale BFF is still bound — kill it, confirm the port is free, relaunch.

## Boot against the local OAP

```bash
REPO="$(git rev-parse --show-toplevel)"
# 1. Kill prior dev servers AND confirm the BFF port is actually free —
#    a stale BFF holding it makes the new one die on EADDRINUSE while
#    the old config keeps serving (see "stale-process trap"). For a
#    parallel env on custom ports, export BFF_PORT / UI_DEV_PORT first.
pkill -f "tsx watch src/server.ts" 2>/dev/null
pkill -f "tsx/dist/cli.mjs watch" 2>/dev/null; pkill -f vite 2>/dev/null
until ! lsof -nP -iTCP:"${BFF_PORT:-8081}" -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done

# 2. BFF — absolute config path is mandatory (see gotcha above). The
#    yaml resolves ${BFF_PORT:8081} at load time, so just exporting
#    BFF_PORT before this command is enough:
HORIZON_CONFIG="$REPO/.claude/skills/local-boot/horizon.local.yaml" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &

# 3. UI — IPv4 host + loopback proxy bypass (run the binary directly so
#    --host actually applies). vite.config.ts reads BFF_PORT and
#    UI_DEV_PORT from this env:
( cd "$REPO/apps/ui" && \
  env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      no_proxy="localhost,127.0.0.1,::1" NO_PROXY="localhost,127.0.0.1,::1" \
      node_modules/.bin/vite --host 127.0.0.1 & )
```

Then open **`http://127.0.0.1:${UI_DEV_PORT:-9091}`** and log in as `admin` / `admin`.

## Boot against the public demo OAP

The demo OAP needs basic-auth (network username `admin`). The password is
NOT committed — it lives in `oap-password.local` next to this file, which
is git-ignored via the repo-wide `*.local` rule. Source it before booting;
if the file is missing, ask the developer and recreate it (one line, the
password only):

```bash
REPO="$(git rev-parse --show-toplevel)"
SECRET="$REPO/.claude/skills/local-boot/oap-password.local"
if [ -s "$SECRET" ]; then
  OAP_PASSWORD="$(cat "$SECRET")"; export OAP_PASSWORD
else
  read -rsp "Demo OAP password: " OAP_PASSWORD && export OAP_PASSWORD && echo
  printf '%s\n' "$OAP_PASSWORD" > "$SECRET" && chmod 600 "$SECRET"  # cache for next boot
fi

pkill -f "tsx watch src/server.ts" 2>/dev/null
pkill -f "tsx/dist/cli.mjs watch" 2>/dev/null; pkill -f vite 2>/dev/null
until ! lsof -nP -iTCP:"${BFF_PORT:-8081}" -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
HORIZON_CONFIG="$REPO/.claude/skills/local-boot/horizon.demo.yaml" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &
( cd "$REPO/apps/ui" && \
  env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      no_proxy="localhost,127.0.0.1,::1" NO_PROXY="localhost,127.0.0.1,::1" \
      node_modules/.bin/vite --host 127.0.0.1 & )
```

The cached `oap-password.local` is git-ignored, so it is safe to keep on
disk between boots. If it is absent and `OAP_PASSWORD` is unset, ask the
developer rather than guessing. The OAP network username is fixed as
`admin` in `horizon.demo.yaml`.

## Boot against an LDAP directory (test)

`horizon.ldap.yaml` points the BFF at a throwaway OpenLDAP seeded from
`ldap-seed.ldif`. Stand the directory up, seed it, then boot:

```bash
REPO="$(git rev-parse --show-toplevel)"
docker rm -f horizon-ldap 2>/dev/null
docker run -d --name horizon-ldap -p 389:389 -p 636:636 \
  --env LDAP_ORGANISATION="Horizon Test" --env LDAP_DOMAIN="horizon.test" \
  --env LDAP_ADMIN_PASSWORD="admin" osixia/openldap:1.5.0
# wait for slapd, then seed:
until docker exec horizon-ldap ldapwhoami -x -H ldap://localhost \
  -D "cn=admin,dc=horizon,dc=test" -w admin >/dev/null 2>&1; do sleep 1; done
docker cp "$REPO/.claude/skills/local-boot/ldap-seed.ldif" horizon-ldap:/tmp/seed.ldif
docker exec horizon-ldap ldapadd -x -H ldap://localhost \
  -D "cn=admin,dc=horizon,dc=test" -w admin -f /tmp/seed.ldif

pkill -f "tsx watch src/server.ts" 2>/dev/null; pkill -f "tsx/dist/cli.mjs watch" 2>/dev/null
until ! lsof -nP -iTCP:"${BFF_PORT:-8081}" -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
HORIZON_CONFIG="$REPO/.claude/skills/local-boot/horizon.ldap.yaml" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &
```

Test accounts (seeded by `ldap-seed.ldif`). Login users are named after
their role and **password == username**, mirroring `horizon.local.yaml`:

| Login | Group | Role |
|---|---|---|
| `admin` | cn=horizon-admin | admin |
| `operator` | cn=sre | operator |
| `maintainer` | cn=platform | maintainer |
| `viewer` | (none) | viewer (`*` fallback) |

Directory bind account: `cn=admin,dc=horizon,dc=test` / `admin` (override via `LDAP_BIND_PW`).

```bash
# verify a login resolves the expected role:
curl -s --noproxy '*' -H 'Content-Type: application/json' -X POST \
  "http://127.0.0.1:${BFF_PORT:-8081}/api/auth/login" -d '{"username":"admin","password":"admin"}'
```

Note: group resolution runs on the **service bind**, not the user's
credentials (regular users usually can't read the group subtree).

## Verify the BFF is healthy (no browser)

```bash
# --noproxy so a local proxy (ClashX etc.) doesn't 502 the loopback call.
until curl -s --noproxy '*' -m2 -o /dev/null "http://127.0.0.1:${BFF_PORT:-8081}/api/auth/health"; do sleep 1; done
curl -s --noproxy '*' -c /tmp/sw.cookies -H 'Content-Type: application/json' -X POST \
  "http://127.0.0.1:${BFF_PORT:-8081}/api/auth/login" -d '{"username":"admin","password":"admin"}'
# Expect 200 with {username, roles, verbs, landingRoute}. A 401
# "invalid credentials" almost always means the wrong config loaded —
# re-check the absolute HORIZON_CONFIG path and that no stale BFF holds the BFF port.
```

## Editing the configs

These files are the source of truth for dev boot. Keep secrets out:
local-user hashes (password == username) are fine to commit; real OAP
passwords must stay in `${OAP_PASSWORD}` (the loader's `interpolateEnv`
expands `${VAR}` / `${VAR:default}` in the raw YAML before parsing).
To mint a new local-user hash: `pnpm --filter @skywalking-horizon-ui/bff cli:hash`.
