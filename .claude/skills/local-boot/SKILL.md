---
name: local-boot
description: Boot the Horizon UI dev env (BFF + UI) against a local OAP or the public Apache demo OAP, using the static configs bundled with this skill. Handles the apps/bff cwd / HORIZON_CONFIG gotcha and the demo OAP password (kept out of git via ${OAP_PASSWORD}).
user-invocable: true
---

# Boot the Horizon UI local dev env

Two bundled static configs live next to this file:

- `horizon.local.yaml` — local OAP on `127.0.0.1:12800`, no OAP network auth.
- `horizon.demo.yaml` — public Apache demo OAP, OAP password read from `${OAP_PASSWORD}`.

Both define the same throwaway Horizon login users (password == username):
`viewer`, `maintainer`, `operator`, `admin`.

The stack: **BFF** (Fastify) on `:8081`, **UI** (Vite) on `:9091` proxying `/api` → `:8081`. Open **`http://127.0.0.1:9091`** (use the IPv4 literal, not `localhost` — see the proxy/IPv4 section).

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

## The stale-process trap (why a config switch "didn't take")

`tsx watch` keeps the old BFF alive, so a freshly launched BFF with a NEW config silently dies on `EADDRINUSE: 127.0.0.1:8081` while the OLD process keeps serving the OLD OAP. Symptom: you switch local↔demo, everything looks fine, but the UI still shows the previous OAP's data.

Killing matters in two ways:
- `pkill -f "tsx watch src/server.ts"` may miss the actual listener — also `pkill -f "tsx/dist/cli.mjs watch"`, and **verify the port is actually free with `lsof` before relaunching** (loop until free; the watcher can respawn a child).
- After boot, **confirm which OAP the LIVE process is using** — don't trust that your new process won the port. The authoritative check:
  ```bash
  curl -s --noproxy '*' -b /tmp/sw.cookies http://127.0.0.1:8081/api/oap/config | grep -oE '"adminUrl":"[^"]*"'
  # local => http://localhost:12800 ; demo => https://demo.skywalking.apache.org:17128
  ```
  Also grep the boot log for `EADDRINUSE` and the `configPath` line. If the adminUrl is wrong, a stale BFF is still bound — kill it, confirm `:8081` is free, relaunch.

## Boot against the local OAP

```bash
REPO="$(git rev-parse --show-toplevel)"
# 1. Kill prior dev servers AND confirm :8081 is actually free — a stale
#    BFF holding the port makes the new one die on EADDRINUSE while the
#    old config keeps serving (see "stale-process trap"):
pkill -f "tsx watch src/server.ts" 2>/dev/null
pkill -f "tsx/dist/cli.mjs watch" 2>/dev/null; pkill -f vite 2>/dev/null
until ! lsof -nP -iTCP:8081 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done

# 2. BFF — absolute config path is mandatory (see gotcha above):
HORIZON_CONFIG="$REPO/.claude/skills/local-boot/horizon.local.yaml" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &

# 3. UI — IPv4 host + loopback proxy bypass (run the binary directly so
#    --host actually applies):
( cd "$REPO/apps/ui" && \
  env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      no_proxy="localhost,127.0.0.1,::1" NO_PROXY="localhost,127.0.0.1,::1" \
      node_modules/.bin/vite --host 127.0.0.1 & )
```

Then open **`http://127.0.0.1:9091`** and log in as `admin` / `admin`.

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
until ! lsof -nP -iTCP:8081 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
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
until ! lsof -nP -iTCP:8081 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
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
  http://127.0.0.1:8081/api/auth/login -d '{"username":"admin","password":"admin"}'
```

Note: group resolution runs on the **service bind**, not the user's
credentials (regular users usually can't read the group subtree).

## Verify the BFF is healthy (no browser)

```bash
# --noproxy so a local proxy (ClashX etc.) doesn't 502 the loopback call.
until curl -s --noproxy '*' -m2 -o /dev/null http://127.0.0.1:8081/api/auth/health; do sleep 1; done
curl -s --noproxy '*' -c /tmp/sw.cookies -H 'Content-Type: application/json' -X POST \
  http://127.0.0.1:8081/api/auth/login -d '{"username":"admin","password":"admin"}'
# Expect 200 with {username, roles, verbs, landingRoute}. A 401
# "invalid credentials" almost always means the wrong config loaded —
# re-check the absolute HORIZON_CONFIG path and that no stale BFF holds :8081.
```

## Editing the configs

These files are the source of truth for dev boot. Keep secrets out:
local-user hashes (password == username) are fine to commit; real OAP
passwords must stay in `${OAP_PASSWORD}` (the loader's `interpolateEnv`
expands `${VAR}` / `${VAR:default}` in the raw YAML before parsing).
To mint a new local-user hash: `pnpm --filter @skywalking-horizon-ui/bff cli:hash`.
