# End-to-end tests

Runs Horizon against a **real OAP** on **BanyanDB**, fed by an instrumented demo app, and verifies both halves of the product: the BFF's HTTP surface and the rendered UI in a headless browser.

This is the gate that unit tests and `tsc` cannot be. A green type-check proves the code compiles; it does not prove a widget resolves its MQE against live data, that the trace list renders what the BFF returned, or that a view mounts at all.

Driven by [skywalking-infra-e2e](https://github.com/apache/skywalking-infra-e2e) — the same harness every other e2e in the SkyWalking project uses.

## Layout

```
test/e2e/
  script/
    env                          image pins, loaded by every case
    docker-compose/
      base-compose.yml           service definitions shared by all cases
    Dockerfile.demo-service      agent image + upstream service jar
    prepare/                     installers and helpers used by cases
  cases/
    core/                        the baseline stack — traces, metrics, logs,
      e2e.yaml                   topology, events, DSL, and the UI for each
      docker-compose.yml         extends the base; adds ports + depends_on
      expected/                  expected output per verify case
    es/                          ElasticSearch storage — the only path that
                                 reaches Horizon's pre-v2 trace query
    browser/                     browser telemetry — OAP's browser receiver
                                 and the BROWSER layer
    admin/                       the WRITE paths — DSL hot-update and
                                 template CRUD, isolated because they mutate
                                 the backend other cases read; covers the
                                 admin screens in a browser too
    istio/                       a real service mesh on kind, not compose —
      e2e.yaml                   the MESH layer built from Envoy access logs,
      kind.yaml                  the `card` widget form, Zipkin traces fed by
      horizon.yaml               Envoy, and rover's profiling pages
      rover.yaml
  playwright/                    the Playwright project: config + specs
```

A case never redefines a service — it `extends` the one it needs from `base-compose.yml` and adds only what is case-specific. `extends` deliberately does not carry `depends_on`, so each case declares its own ordering; that is upstream's convention too.

Playwright is reached through one verify line per case, so every case reuses the same login, fixtures and config rather than standing up a second browser suite. The PROJECT differs per case, though — see below.

## What the core case stands up

| Service | Image | Notes |
| --- | --- | --- |
| `banyandb` | `ghcr.io/apache/skywalking-banyandb` | Storage. OAP's default selector, so no override needed. |
| `oap` | `ghcr.io/apache/skywalking/oap` | Query on 12800, admin host (`ui-management`) on 17128. |
| `provider` / `consumer` | SkyWalking Java agent + upstream e2e service jar | The demo app. Reports as `e2e-service-provider` / `e2e-service-consumer` in the `GENERAL` layer. |
| `horizon` | built from this checkout | `templates.mode: live`, local auth, one admin account. |

Every upstream image is **pinned by commit SHA in [`script/env`](script/env)**, the same shape as `apache/skywalking`'s `test/e2e-v2/script/env`. Nothing is built from an upstream checkout, so this directory plus that file is the entire dependency on the SkyWalking repo.

## Run it locally

Everything here works on macOS — all pinned images publish `linux/arm64` as well as `linux/amd64`, so nothing is emulated.

You need the `e2e` CLI on `PATH`:

```bash
go install github.com/apache/skywalking-infra-e2e/cmd/e2e@latest
```

Then:

```bash
make -C test/e2e images            # build horizon-ui:e2e + the demo services
make -C test/e2e run CASE=core     # full cycle: setup, trigger, verify, cleanup
```

`make images` is the slow one and only needs re-running when app code changes. While iterating on compose or specs, `make images-demo` skips the Horizon build.

### Iterating on specs

`make run` tears the stack down at the end, and `e2e setup` on its own is no help: the cases set `cleanup: on: always`, which leaves testcontainers' reaper enabled, so every container dies the moment the CLI process exits. Use the `dev` targets, which drive compose directly and hold the stack open:

```bash
make -C test/e2e dev                     # start, stay up
make -C test/e2e dev-traffic             # drive the demo app (~2 min)
make -C test/e2e dev-url                 # → http://127.0.0.1:<port>

cd test/e2e/playwright
HORIZON_BASE_URL=<url> pnpm exec playwright test --project=ui --headed
open playwright-report/index.html

make -C test/e2e dev-logs                # when something looks wrong
make -C test/e2e dev-down
```

**`dev-traffic` is not optional.** The stack on its own produces no telemetry — in a case run it is infra-e2e's `trigger` block that drives the demo app, and the `dev` targets have no equivalent. Skip it and the service roster is empty, so most specs fail against a perfectly good build. Re-run it whenever the data has aged out of the window you are looking at.

The `dev` stack uses its own compose project name, so it never collides with a case run.

Host ports are ephemeral, not fixed: infra-e2e maps them and exports `${horizon_host}` / `${horizon_8081}` to the verify cases. That is what lets two cases run back to back without colliding, and it is why `HORIZON_BASE_URL` has no default — a default would let the suite run green against a stale stack from a previous case.

### Not runnable locally

Cases needing **rover / eBPF** cannot run on macOS: eBPF needs a Linux kernel, and those cases use infra-e2e's `kind` environment rather than compose. Nothing in the core fixture uses them.

## Adding a case

1. `mkdir test/e2e/cases/<name>` with an `e2e.yaml`, plus a `docker-compose.yml` that `extends` the base — or, for a `kind` case, a `kind.yaml` and the manifests it applies. A kind case must list EVERY image it runs under `import-images`: the node has no guaranteed outbound access (see the proxy note in CLAUDE.md).
2. Add expected files under `cases/<name>/expected/`. **Write them before the first run** — a missing expected file is retried for the whole budget and can never succeed, so a typo costs the full retry window rather than failing fast.
3. Add one entry to the `case:` matrix in `.github/workflows/e2e.yaml`, and an entry to the case table in its header comment — that table is the single source of truth for coverage, and the case echoes its own entry to the console before it boots.

If the case needs UI coverage, add specs under `playwright/specs/` and call `script/prepare/playwright.sh <project>` from a verify case.

**A Playwright project shared between cases couples them: a spec added for one becomes a requirement for every case that runs it,** including cases that never run the readiness gate it depends on. So each case has its OWN project matching `specs/<project>/` — `es` runs only the pre-v2 trace spec, `browser` only the Browser Errors spec, `istio` the mesh specs. `auth` is the exception: it is nobody's project and everybody's dependency, signing in once and sharing the session.

## Writing a spec that will not flake

- **Assert on lists, not on chart points.** The fixture is minutes old. A widget on a 30-minute window over a two-minute-old OAP is legitimately empty; asserting "the chart has points" makes the suite fail for a correct UI.
- **Scope UI locators to the element you mean.** Chart tooltips repeat endpoint names inside SVG `<title>` nodes, which match a text query but are never visible — a bare `getByText` can pass on a page whose list came back empty. Read the rendered DOM rather than inferring a selector from the component tree; the widgets do not always use the primitive you would expect.
- **Cascade-clear is a real state.** The UI resets a dependent area and shows a reading hint before its query lands. Wait for the resolved state, never assert on the frame between the click and the result.
- **No retries.** `retries: 0` is deliberate — a rerun hides exactly the class of flake this suite exists to find. An intermittent failure means the wait is wrong. Slow-to-settle data belongs in the case's `verify.retry` budget instead, where it is declared once.
- **OAP data is never translated.** Service and endpoint names come over the wire verbatim, so they are safe to assert on literally. UI chrome is i18n-resolved — match structure or classes, not English strings.

## Bumping the pins

Pick a commit from the relevant upstream master, confirm the image tag exists, then edit [`script/env`](script/env):

```bash
docker manifest inspect ghcr.io/apache/skywalking/oap:<sha>
```

The OAP pin must stay at or after `5b481a41a9` (#13877) — the commit that added the `ui-management` module Horizon's template store talks to. Below it, `templates.mode: live` cannot work at all.

Never replace a pin with `latest`: an unrelated push to an upstream master would then turn this repo's CI red with no commit of ours involved, and it would read as our regression.

**Nothing in `script/env` may be quoted.** infra-e2e reads it by splitting each line on the first `=` and exporting the remainder verbatim — no quote stripping, no expansion. A quoted value ships its quote characters into the container. For the same reason no script may shell-source the file; read individual keys instead, as `script/prepare/build-images.sh` does.
