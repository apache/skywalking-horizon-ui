---
name: local-boot
description: Boot the Horizon UI dev env (BFF + UI) against a local OAP or the public Apache demo OAP. Uses the repo's committed, env-driven horizon.yaml — the same config the image ships — and injects the OAP target + dev users purely via HORIZON_* environment variables. Handles the apps/bff cwd / HORIZON_CONFIG gotcha and the demo OAP password (kept out of git via the cached oap-demo-env-auth.key). Also covers booting with the AI assistant enabled (Amazon Bedrock / DeepSeek), keyed from the git-ignored bedrocks-api.key.
user-invocable: true
---

# Boot the Horizon UI local dev env

There is **one config file**: the repo's committed `horizon.yaml` at the
repo root. Every field in it is a `${HORIZON_…:default}` token, so dev boots
use the SAME file the Docker image ships and override only what they need via
**environment variables** — there are no per-scenario config files anymore.

Two committed helpers live next to this file (throwaway dev values, safe to
commit):

- `dev-users.json` — the four local login users (`viewer` / `maintainer` /
  `operator` / `admin`, **password == username**), as a **single-line** JSON
  array for `HORIZON_AUTH_LOCAL_USERS`.
- `dev-ldap.json` — the test-OpenLDAP config for `HORIZON_AUTH_LDAP` (single line).

The stack: **BFF** (Fastify) on `:8081`, **UI** (Vite) on `:9091` proxying
`/api` → `:8081`. Open **`http://127.0.0.1:9091`** (use the IPv4 literal, not
`localhost` — see the proxy/IPv4 section). Both ports are overridable — see
"Custom ports".

> **JSON env values must be SINGLE-LINE.** `HORIZON_AUTH_LOCAL_USERS`,
> `HORIZON_OAP_AUTH`, `HORIZON_AUTH_LDAP`, etc. are spliced into the YAML before
> parsing; a multi-line JSON value breaks the parse (`YAMLParseError: Flow
> sequence … must be sufficiently indented`). The `dev-*.json` files are already
> single-line — keep them that way.

## Environment variables (the dev contract)

Local dev runs as **two processes / two ports**: the BFF (Fastify, owns `/api`)
and Vite (serves the UI, proxies `/api` → BFF). The BFF reads `HORIZON_*` via the
config loader's `${VAR:default}` interpolation; Vite reads `BFF_PORT` +
`UI_DEV_PORT` directly in `apps/ui/vite.config.ts`.

| Variable                    | Default                    | Used by | Purpose |
|---|---|---|---|
| `HORIZON_CONFIG`            | _(none — required)_        | BFF     | **Absolute** path to the config. Always `"$REPO/horizon.yaml"`. A bare `./horizon.yaml` resolves under `apps/bff/` — see "The one gotcha". |
| `HORIZON_SERVER_PORT`       | `8081`                     | BFF     | BFF listen port (`server.port`). For a custom port set this AND `BFF_PORT` to the same value. |
| `BFF_PORT`                  | `8081`                     | UI      | Vite's `/api` proxy target. Must match `HORIZON_SERVER_PORT`. |
| `UI_DEV_PORT`               | `9091`                     | UI      | Vite listen port. Dev-only. |
| `HORIZON_OAP_QUERY_URL`     | `http://127.0.0.1:12800`   | BFF     | OAP GraphQL endpoint. |
| `HORIZON_OAP_ADMIN_URL`     | `http://127.0.0.1:17128`   | BFF     | OAP admin REST endpoint. Often a different port from GraphQL (the demo splits on `:17128`) — if the BFF logs `UITemplate 404`, this is wrong. |
| `HORIZON_OAP_ZIPKIN_URL`    | `http://127.0.0.1:9412/zipkin` | BFF | Zipkin query endpoint (Zipkin trace layer). |
| `HORIZON_OAP_TIMEOUT_MS`    | `15000`                    | BFF     | OAP request timeout. Lower it (`4000`) when previewing the "OAP unreachable" landing block so errors surface fast. |
| `HORIZON_OAP_AUTH`          | _(none)_                   | BFF     | OAP basic-auth as JSON, e.g. `{"username":"admin","password":"…"}`. The demo needs it (password from `oap-demo-env-auth.key`). |
| `HORIZON_AUTH_LOCAL_USERS`  | `[]`                       | BFF     | Local login users (JSON array, single-line). Use `$(cat dev-users.json)`. |
| `HORIZON_AUTH_BACKEND`      | `local`                    | BFF     | `local` or `ldap`. |
| `HORIZON_AUTH_LDAP`         | _(none)_                   | BFF     | LDAP config (JSON, single-line) when backend=ldap. Use `$(cat dev-ldap.json)`. |
| `HORIZON_TEMPLATES_MODE`    | `live`                     | BFF     | `live` (seed + read ui_template) or `readonly` (render the bundle, config read-only). |

RBAC is left to the built-in role defaults (the `horizon.yaml` token
`roles: ${HORIZON_RBAC_ROLES:null}` falls through to them), so no roles env var
is needed for dev.

## The one gotcha that bites every time

The BFF dev script is `tsx watch src/server.ts` and pnpm runs it with **cwd =
`apps/bff`**. The config path defaults to `./horizon.yaml`, resolved relative to
cwd — so a bare `./horizon.yaml` points at the non-existent `apps/bff/horizon.yaml`
(NOT the repo-root one), and the loader silently falls back to schema defaults
with **zero users** (every login then fails "invalid credentials").

**Always pass `HORIZON_CONFIG` as an ABSOLUTE path:** `"$REPO/horizon.yaml"`.

## Proxy + IPv4 (the second gotcha)

Two things make the UI look "not accessible" even when Vite is running:

- **Vite binds IPv6 `[::1]` by default**, so `127.0.0.1:9091` (IPv4) has nothing and many browsers / curl fail. **Force IPv4** with `--host 127.0.0.1`. Note `pnpm --filter ui run dev -- --host …` does NOT forward the flag — run the Vite binary directly (`apps/ui/node_modules/.bin/vite --host 127.0.0.1`).
- **A local proxy** (ClashX / v2ray etc. — `http_proxy` / `https_proxy` / `all_proxy` pointing at `127.0.0.1:<port>`) intercepts loopback and returns `502`. Detect and bypass it for the dev hosts.

Detect a local proxy before booting:
```bash
env | grep -iE '^(http_proxy|https_proxy|all_proxy)=' && echo "local proxy detected — will bypass loopback"
```

The browser uses its OWN proxy settings (not the shell's), so the developer must also let `127.0.0.1` / `localhost` go direct (ClashX "bypass localhost" / system proxy no-proxy list). The env-level bypass below only fixes CLI tools and Vite's own fetches.

## The stale-process trap (why a config switch "didn't take")

`tsx watch` keeps the old BFF alive, so a freshly launched BFF silently dies on `EADDRINUSE: 127.0.0.1:8081` while the OLD process keeps serving the OLD env. Symptom: you switch demo↔local, everything looks fine, but the UI still shows the previous OAP's data.

- `pkill -f "tsx watch src/server.ts"` may miss the actual listener — also `pkill -f "tsx/dist/cli.mjs watch"`, and **verify the port is free with `lsof` before relaunching** (loop until free; the watcher respawns a child).
- After boot, **confirm which OAP the LIVE process uses** — don't trust that your new process won the port:
  ```bash
  curl -s --noproxy '*' -b /tmp/sw.cookies "http://127.0.0.1:8081/api/oap/config" | grep -oE '"adminUrl":"[^"]*"'
  # local => http://127.0.0.1:17128 ; demo => https://demo.skywalking.apache.org:17128
  ```

## Boot against the public demo OAP

The demo OAP needs basic-auth (network username `admin`). The password is NOT
committed — it lives in `oap-demo-env-auth.key` next to this file (git-ignored via
the `.claude/skills/local-boot/*.key` rule). Source it; if missing, ask the developer and
recreate it (one line, the password only).

```bash
REPO="$(git rev-parse --show-toplevel)"
SECRET="$REPO/.claude/skills/local-boot/oap-demo-env-auth.key"
if [ -s "$SECRET" ]; then
  OAP_PASSWORD="$(cat "$SECRET")"; export OAP_PASSWORD
else
  read -rsp "Demo OAP password: " OAP_PASSWORD && export OAP_PASSWORD && echo
  printf '%s\n' "$OAP_PASSWORD" > "$SECRET" && chmod 600 "$SECRET"  # cache for next boot
fi

# Kill prior dev servers + confirm the port is free (see stale-process trap).
pkill -f "tsx watch src/server.ts" 2>/dev/null
pkill -f "tsx/dist/cli.mjs watch" 2>/dev/null; pkill -f vite 2>/dev/null
until ! lsof -nP -iTCP:8081 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done

# BFF — repo horizon.yaml + everything via env. JSON values are single-line.
SK="$REPO/.claude/skills/local-boot"
HORIZON_CONFIG="$REPO/horizon.yaml" \
HORIZON_OAP_QUERY_URL=https://demo.skywalking.apache.org:12800 \
HORIZON_OAP_ADMIN_URL=https://demo.skywalking.apache.org:17128 \
HORIZON_OAP_ZIPKIN_URL=https://demo.skywalking.apache.org:9412/zipkin \
HORIZON_OAP_AUTH="{\"username\":\"admin\",\"password\":\"$OAP_PASSWORD\"}" \
HORIZON_AUTH_LOCAL_USERS="$(cat "$SK/dev-users.json")" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &

# UI — IPv4 host + loopback proxy bypass (run the binary directly so --host applies).
( cd "$REPO/apps/ui" && \
  env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      no_proxy="localhost,127.0.0.1,::1" NO_PROXY="localhost,127.0.0.1,::1" \
      node_modules/.bin/vite --host 127.0.0.1 & )
```

Then open **`http://127.0.0.1:9091`** and log in as `admin` / `admin`. To boot in
read-only template mode, add `HORIZON_TEMPLATES_MODE=readonly` to the BFF line.

## Boot with the AI assistant enabled (Bedrock / DeepSeek)

The AI assistant (the `ai:` block in `horizon.yaml`) is **off by default** — the
launcher stays hidden until the feature is enabled AND a usable provider is
configured. To exercise it in dev, add the `HORIZON_AI_*` env vars below to any
boot above — usually the **demo** boot, so there is live data to investigate.

The dev provider is **Amazon Bedrock** running **DeepSeek** (`deepseek.v3.2`,
region `us-west-2`). The Bedrock key is a secret kept next to this file:

- `bedrocks-api.key` — a Bedrock **`ABSK…` bearer token**, one line, git-ignored
  via the `.claude/skills/local-boot/*.key` rule (same rule as the OAP password).
  If missing, mint one in the AWS console (Bedrock → API keys) and drop it here.

Our config field is **`HORIZON_AI_API_KEY`** — the BFF passes it to the SDK
explicitly as `bedrockBearerToken`. Do **NOT** set `AWS_BEARER_TOKEN_BEDROCK`:
that is the AWS SDK's own env var, which our code deliberately bypasses so
concurrent requests stay isolated. The **only bedrock-specific
extra is `HORIZON_AI_REGION`** (it falls back to `AWS_REGION` when blank). Our
bedrock path REQUIRES the bearer key and does **not** use the AWS SSO / IAM
credential chain — a missing key is a clean 503, not an SSO prompt.

| Variable                    | Value (dev)               | Purpose |
|---|---|---|
| `HORIZON_AI_ENABLED`        | `true`                    | Master switch (default `false`). |
| `HORIZON_AI_PROVIDER`       | `bedrock`                 | Transport — `openai-compatible` (default) or `bedrock`. |
| `HORIZON_AI_MODEL`          | `deepseek.v3.2`           | Bedrock model / inference-profile id. |
| `HORIZON_AI_REGION`         | `us-west-2`               | Bedrock-only extra; falls back to `AWS_REGION`. |
| `HORIZON_AI_API_KEY`        | `$(cat bedrocks-api.key)` | **Secret** `ABSK` bearer. Redacted from logs, excluded from the audit trail. |

Add these lines to the demo boot's BFF invocation (keep the SECRET / pkill /
port-free steps from the demo section):

```bash
SK="$REPO/.claude/skills/local-boot"
HORIZON_CONFIG="$REPO/horizon.yaml" \
HORIZON_OAP_QUERY_URL=https://demo.skywalking.apache.org:12800 \
HORIZON_OAP_ADMIN_URL=https://demo.skywalking.apache.org:17128 \
HORIZON_OAP_ZIPKIN_URL=https://demo.skywalking.apache.org:9412/zipkin \
HORIZON_OAP_AUTH="{\"username\":\"admin\",\"password\":\"$OAP_PASSWORD\"}" \
HORIZON_AUTH_LOCAL_USERS="$(cat "$SK/dev-users.json")" \
HORIZON_AI_ENABLED=true \
HORIZON_AI_PROVIDER=bedrock \
HORIZON_AI_MODEL=deepseek.v3.2 \
HORIZON_AI_REGION=us-west-2 \
HORIZON_AI_API_KEY="$(cat "$SK/bedrocks-api.key")" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &
```

Verify readiness after login — expect `ready:true`:
```bash
curl -s --noproxy '*' -b /tmp/sw.cookies "http://127.0.0.1:8081/api/ai/config"
```
Then the floating **AI Assistant** launcher appears on the right edge; the chat
streams an answer with inline figures (open `/ai` for the full page). **On-demand
pod logs** work when the OAP itself runs in Kubernetes (the public demo does) and
its `enableOnDemandPodLog` is on — the assistant's `fetch_pod_logs` tool and the
per-layer Pod Logs tab both read them live.

## Boot against a local / remote no-auth OAP

Same recipe, different OAP env vars (no `HORIZON_OAP_AUTH` for a no-auth OAP):

```bash
REPO="$(git rev-parse --show-toplevel)"; SK="$REPO/.claude/skills/local-boot"
pkill -f "tsx watch src/server.ts" 2>/dev/null; pkill -f "tsx/dist/cli.mjs watch" 2>/dev/null; pkill -f vite 2>/dev/null
until ! lsof -nP -iTCP:8081 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done

# LOCAL OAP (defaults already point at 127.0.0.1, so only users are needed):
HORIZON_CONFIG="$REPO/horizon.yaml" \
HORIZON_AUTH_LOCAL_USERS="$(cat "$SK/dev-users.json")" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &

# REMOTE no-auth OAP (GraphQL 12800, admin split on 17128):
HORIZON_CONFIG="$REPO/horizon.yaml" \
HORIZON_OAP_QUERY_URL=http://oap.dev.example:12800 \
HORIZON_OAP_ADMIN_URL=http://oap.dev.example:17128 \
HORIZON_AUTH_LOCAL_USERS="$(cat "$SK/dev-users.json")" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &

# UNREACHABLE-OAP landing-block preview (short timeout so errors surface fast):
HORIZON_CONFIG="$REPO/horizon.yaml" \
HORIZON_OAP_QUERY_URL=http://127.0.0.1:12801 HORIZON_OAP_ADMIN_URL=http://127.0.0.1:12801 \
HORIZON_OAP_TIMEOUT_MS=4000 \
HORIZON_AUTH_LOCAL_USERS="$(cat "$SK/dev-users.json")" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &
```

## Custom ports (two parallel envs)

Defaults are BFF `:8081`, UI `:9091`. To run a second Horizon side-by-side, set
the BFF port via **`HORIZON_SERVER_PORT`** (the config's `server.port` token) AND
**`BFF_PORT`** (Vite's proxy target) to the same value, plus `UI_DEV_PORT`:

```bash
HORIZON_SERVER_PORT=10081 BFF_PORT=10081 UI_DEV_PORT=10091 \
  HORIZON_CONFIG="$REPO/horizon.yaml" \
  HORIZON_AUTH_LOCAL_USERS="$(cat "$SK/dev-users.json")" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &
( cd "$REPO/apps/ui" && BFF_PORT=10081 UI_DEV_PORT=10091 \
    env -u http_proxy -u https_proxy -u all_proxy \
        node_modules/.bin/vite --host 127.0.0.1 & )
```

**Prod is single-port.** The BFF serves the built UI as static files, so
`UI_DEV_PORT` is meaningless outside Vite; only `HORIZON_SERVER_PORT` matters.

## Boot against an LDAP directory (test)

Stand up a throwaway OpenLDAP, seed it from `ldap-seed.ldif`, then boot with
`HORIZON_AUTH_BACKEND=ldap` and the LDAP config from `dev-ldap.json`. Test logins
mirror the local set (password == username): `admin` → admin, `operator` →
operator, `maintainer` → maintainer, `viewer` → viewer (`*` fallback). The bind
account is `cn=admin,dc=horizon,dc=test` / `admin`.

```bash
REPO="$(git rev-parse --show-toplevel)"; SK="$REPO/.claude/skills/local-boot"
docker rm -f horizon-ldap 2>/dev/null
docker run -d --name horizon-ldap -p 389:389 -p 636:636 \
  --env LDAP_ORGANISATION="Horizon Test" --env LDAP_DOMAIN="horizon.test" \
  --env LDAP_ADMIN_PASSWORD="admin" osixia/openldap:1.5.0
until docker exec horizon-ldap ldapwhoami -x -H ldap://localhost \
  -D "cn=admin,dc=horizon,dc=test" -w admin >/dev/null 2>&1; do sleep 1; done
docker cp "$SK/ldap-seed.ldif" horizon-ldap:/tmp/seed.ldif
docker exec horizon-ldap ldapadd -x -H ldap://localhost \
  -D "cn=admin,dc=horizon,dc=test" -w admin -f /tmp/seed.ldif

pkill -f "tsx watch src/server.ts" 2>/dev/null; pkill -f "tsx/dist/cli.mjs watch" 2>/dev/null
until ! lsof -nP -iTCP:8081 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
HORIZON_CONFIG="$REPO/horizon.yaml" \
HORIZON_AUTH_BACKEND=ldap \
HORIZON_AUTH_LDAP="$(cat "$SK/dev-ldap.json")" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &
```

`dev-ldap.json` reads the bind password as the test value `admin`; for a real
directory, edit it (or build the JSON with your own bind password) and never
commit a real one. Group resolution runs on the **service bind**, not the user's
credentials.

## Verify the BFF is healthy (no browser)

```bash
# --noproxy so a local proxy (ClashX etc.) doesn't 502 the loopback call.
until curl -s --noproxy '*' -m2 -o /dev/null "http://127.0.0.1:8081/api/auth/health"; do sleep 1; done
curl -s --noproxy '*' -c /tmp/sw.cookies -H 'Content-Type: application/json' -X POST \
  "http://127.0.0.1:8081/api/auth/login" -d '{"username":"admin","password":"admin"}'
# Expect 200 with {username, roles, verbs, landingRoute}. A 401 "invalid
# credentials" usually means HORIZON_AUTH_LOCAL_USERS wasn't passed (or the
# wrong HORIZON_CONFIG path / a stale BFF holds the port).
```

## Editing the dev values

`horizon.yaml` (repo root) is the committed, env-driven config — leave it as-is
and override via `HORIZON_*` env vars. The dev users / LDAP config live in
`dev-users.json` / `dev-ldap.json` here (throwaway, single-line JSON). Real
secrets stay out of git via the `.claude/skills/local-boot/*.key` rule: the demo
OAP password in `oap-demo-env-auth.key` and the Bedrock bearer in
`bedrocks-api.key` are both git-ignored; real LDAP bind passwords are supplied at
boot. To mint a new local-user hash: `pnpm --filter @skywalking-horizon-ui/bff cli:hash`.
