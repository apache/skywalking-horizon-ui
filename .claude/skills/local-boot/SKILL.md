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

## Boot against the local OAP

```bash
REPO="$(git rev-parse --show-toplevel)"
# 1. Make sure nothing stale holds the BFF port (a wrong-config process
#    on :8081 makes a fresh one fail with EADDRINUSE and you keep hitting
#    the old one). Kill any prior dev servers first:
pkill -f "tsx watch src/server.ts" 2>/dev/null; pkill -f vite 2>/dev/null; sleep 1

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

The demo OAP needs basic-auth. The password is NOT committed — ask the
developer for it and export it before booting:

```bash
REPO="$(git rev-parse --show-toplevel)"
read -rsp "Demo OAP password: " OAP_PASSWORD && export OAP_PASSWORD && echo

pkill -f "tsx watch src/server.ts" 2>/dev/null; pkill -f vite 2>/dev/null; sleep 1
HORIZON_CONFIG="$REPO/.claude/skills/local-boot/horizon.demo.yaml" \
  pnpm --filter @skywalking-horizon-ui/bff run dev &
( cd "$REPO/apps/ui" && \
  env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      no_proxy="localhost,127.0.0.1,::1" NO_PROXY="localhost,127.0.0.1,::1" \
      node_modules/.bin/vite --host 127.0.0.1 & )
```

When invoked as an agent and `OAP_PASSWORD` is not already set, ask the
developer for it (do not guess, do not hardcode it into a file). The OAP
network username is fixed as `admin` in `horizon.demo.yaml`.

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
