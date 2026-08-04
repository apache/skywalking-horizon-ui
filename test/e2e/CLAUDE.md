# CLAUDE.md — principles for `test/e2e`

This file states the **principles** for the end-to-end suite. Mechanics — how to run a case, what each script does, how to add one — live in [README.md](README.md) and in the code. Read this before adding or changing a case.

## 0. How a run flows

One CI job per case, all in parallel, from the matrix in `.github/workflows/e2e.yaml`. Wall clock is therefore roughly one case, not their sum — which is why a new case costs a stack, not a delay.

```
build images ──▶ infra-e2e run ──▶ setup ──▶ trigger ──▶ verify ──▶ cleanup
                                     │         │           │
                                     │         │           ├─ gates    (wire, cheap, §3.3)
                                     │         │           └─ browser  (playwright.sh <project>)
                                     │         └─ continuous traffic, one per case
                                     └─ compose up + tools + data seeding
```

**Images first.** `make -C test/e2e images` builds the two things no registry carries: Horizon from *this* commit, and the demo services (upstream's service jar on upstream's agent image). Compose sets `pull_policy: never` for both, so a missing build fails loudly instead of silently testing someone else's image.

**Setup** announces the case's scope first — read out of the case table in `.github/workflows/e2e.yaml` and printed before anything boots, so a red run says what this case was responsible for before it says what broke. Then it brings up the stack — `cases/<name>/docker-compose.yml` extending `script/docker-compose/base-compose.yml` — and runs the case's remaining steps: install `yq` and `swctl`, pre-pull the browser image, and seed any data the single `trigger` cannot produce.

**Trigger** is one continuous HTTP loop, and a case gets exactly one. Anything else a fixture needs (log traffic, browser errors) is seeded in a setup step instead.

**Verify** runs cases in order, and the order is load-bearing: readiness gates first so the wait lands on one cheap query, then the browser projects. A gate that fails tells you the fixture is not ready; a browser case that fails tells you the product is wrong.

**Cleanup** is `on: always`.

### Projects

`playwright.sh <project>` runs one Playwright project inside the pinned Ubuntu image, joined to the fixture's own compose network so it reaches Horizon by service name. It prints only `passed: true|false` — that single line is the whole contract with infra-e2e; assertions and diagnostics live on the Playwright side.

One project per case, matching `specs/<project>/`. `auth` is the exception: it is nobody's project, it is a *dependency* of every other, signing in once and sharing the session.

A project shared between cases couples them — a spec added for one becomes a requirement for all of them, including cases that do not run the gate it depends on. Prefer a project per case over a shared one.

### On failure

`playwright.sh` records the first failure and short-circuits the rest of infra-e2e's retry budget: a browser suite that failed once against a ready fixture will fail again, and re-running it would overwrite the artifacts from the attempt closest to the cause.

What gets uploaded: the Playwright HTML report, traces and screenshots; the browser console and uncaught page errors; and the container logs, one file per container.

For a **kind** case that is not enough on its own — a cluster failure is usually about what never *started*, and that lives in events, `describe` output, and the previous container's log rather than in any running container's stdout.

So the browser runner collects those itself the moment it fails: `pods.txt` (the whole-cluster shape, the first file to open), cluster-wide events, per-pod `describe`, the **previous** container's log wherever something restarted, rover's log on its own, and `istioctl proxy-status` / `analyze`.

**It has to happen there, not in a later CI step.** `cleanup: on: always` deletes the kind cluster as the case ends, so anything that runs afterwards finds no cluster and collects an empty directory — which looks like working diagnostics until you open them. Artifacts are named after the case rather than the matrix index.

### Locally

`make -C test/e2e run CASE=<name>` is the same path CI takes. `make dev` holds a stack open for iteration — it needs `make dev-traffic` too, because without the trigger the stack produces no telemetry.

Any pin in [`script/env`](script/env) can be overridden by exporting it in your shell — the value you export wins over the file, so trying another version needs no edit to a tracked file you then have to remember not to commit.

### Behind a local proxy

A proxy on the host's loopback — `http_proxy=http://127.0.0.1:7897` and friends, the usual shape of a desktop proxy client — **breaks a kind case in a way that does not look like a proxy problem**. kind copies `HTTP_PROXY`/`HTTPS_PROXY` out of the environment and into the node container, where `127.0.0.1` is the NODE's loopback and nothing is listening on it. Every image pull then fails, against every registry, and it surfaces minutes into an install as:

```
ImagePullBackOff
proxyconnect tcp: dial tcp 127.0.0.1:7897: connect: connection refused
```

That reads like a registry outage or a rate limit. It is neither, and it is why `docker pull` of the same image on the host succeeds while the node cannot fetch it.

**The fixture does not work around this — it does not need a registry at all.** Every image a kind case runs is listed in that case's `import-images`, which infra-e2e pulls on the HOST (where the proxy works) and side-loads into the node. Nothing in the cluster ever contacts a registry.

Two consequences worth knowing:

- **Adding a component to a kind case means adding its image to `import-images`.** Miss one and it fails only on a machine with a broken proxy path, or in CI when that registry rate-limits — the two situations where the failure is hardest to read.
- **Do not "fix" this by pointing the proxy at a host-gateway address.** That trades a reproducible fixture for one that depends on the developer's network, and CI has no proxy at all.

Compose cases are unaffected: the containers use the daemon's own image store, which is the host's.

## 1. Real OAP, BanyanDB by default

Every case runs against a **real OAP** with **BanyanDB** storage. Not a mock, not a recorded fixture, not an in-memory stub.

**ElasticSearch only where the backend is the thing under test.** The bar is: *what does this prove that BanyanDB cannot?* If there is no answer, use BanyanDB.

Today the ES case clears that bar three times over, all of them consequences of Horizon classifying the backend as `other` rather than `banyandb`: the pre-v2 trace query (v2 is BanyanDB-only), a v1 row being a *segment* that opens to fetch its full trace, and cold stage being **hidden** rather than offered as a switch that changes nothing. None is reachable on the default stack.

What it must NOT do is re-run the shell and layer journeys. Those pass or fail identically on either backend.

Storage is not a feature. Re-running the same assertions on a second backend doubles the runtime to re-prove what storage does not affect.

## 2. Everything runs through skywalking-infra-e2e

No case may stand up its own stack, drive its own traffic, or run its own assertions outside the harness. The case file owns setup, trigger, verify and cleanup; the harness owns the lifecycle.

This is what the rest of the SkyWalking project uses, and the consistency is the point: a contributor who knows the OAP e2e suite can read this one.

## 3. Verification is a browser assertion

### 3.1 The browser is the test

**A feature is verified when a headless browser shows it.** Assertions are on rendered elements — including the *data* the BFF returned, read back off the page rather than off the wire.

The reasoning is simple: if the rendered page is right, the whole chain beneath it is right. OAP served the data, the BFF shaped it, the router resolved, the component mounted, the widget bound its values. A wire assertion proves one link and stays silent about the rest — a route can return flawless JSON into a view that throws on mount, and the operator sees a blank page.

So: **assert the value on screen, not in the response.**

### 3.2 A BFF assertion needs a reason

Wire-level assertions are allowed **only when the browser cannot reach the behaviour**. Before adding one, answer: *what would this catch that a UI assertion would not?*

Legitimate reasons, in practice:

- **no UI path exists** — a malformed request the client never sends (a half identity, an unknown layer key), where the point is that the BFF *refuses* rather than answering emptily
- **the outcome is invisible on screen** — a status code that the UI renders as a generic error, where the code itself is the contract
- **a mutation the UI cannot safely drive** — a hot-update whose intermediate states would race the rest of the case

"It is easier to assert on JSON" is not a reason. Neither is "for completeness": a BFF test that duplicates a UI assertion costs runtime, and its passing tells you nothing new when the UI test already passed.

### 3.2b Keeping the balance honest

The wire list is meant to stay **short and justified**, not to grow by habit. Two rules keep it that way:

- **Every wire assertion names, in a comment, the thing a browser could not have shown.** If that sentence cannot be written, the assertion belongs in a spec.
- **A wire assertion that a UI assertion now covers is deleted, not kept "for safety".** Rosters, traces, logs, topology, alarms, metrics and templates were all wire assertions once; each was removed when a rendered-page assertion replaced it, because a pass there proves the whole chain rather than one link.

What each case actually covers is not recorded here — it lives in the case table in `.github/workflows/e2e.yaml`, which every case echoes to the console before it boots. A second copy in this file would be a list to maintain rather than a rule to follow, and it would go stale first.

### 3.3 Readiness gates are not tests

Several verify cases exist purely to **wait**: metrics have persisted, the service relation has aggregated, alarms have fired. They query the wire because that is the cheapest way to ask, and they run before the browser cases so the wait lands on one query instead of a whole browser project retrying.

They are synchronisation, not verification — and they should carry a comment saying what they are waiting for and why that wait is real. A gate that asserts a *feature* has quietly become a BFF test; move it.

## 4. When something fails, read the logs

Because verification is a browser assertion, a failure says "the page did not show it" without saying which link broke. That is a deliberate trade: the diagnosis comes from evidence collected on failure, not from a lattice of wire assertions maintained forever.

So the evidence has to be worth reading:

- **the browser side** — Playwright's screenshot, trace and DOM snapshot, plus any uncaught page error the spec captured
- **the server side** — container logs for OAP and Horizon, collected by the harness and uploaded with the run

Both are collected on failure only, and both are uploaded as CI artifacts. **Keep log levels honest**: a real failure must be visible at WARN or ERROR without turning on debug logging, and routine operation must not emit at those levels — a log that cries wolf is worse than no log, because it trains people to skip the artifact.

If the artifact does not explain it, reproduce locally (`make dev`, then drive the suite by hand). Do not add a speculative wire assertion in the hope it narrows a future failure.

## 5. A case earns its stack by DEPLOYMENT

Cases are split by what the deployment must be, never by which feature is under test. Anything the baseline stack can produce belongs in `core`.

The test: *does this need a different backend, receiver, or topology?* If not, it is a spec in an existing case.

Upstream's log case differs from its simple case by two environment variables and a config file — giving that its own stack would spend a minute of container boot to learn nothing.

A case name is therefore a **deployment**, not a feature area: `admin` means "core, kept separate because it mutates OAP", not "the DSL tests". What a case covers is written once, in the case table in `.github/workflows/e2e.yaml`, and every case echoes its own entry from there before it boots. One copy, in the file that has to carry it anyway, printed where a failure is actually read.

A stack costs roughly a minute of boot before a single assertion runs. Assertions are cheap; stacks are not.

## 6. Fixtures are pinned, and never `latest`

Every upstream image is pinned by commit SHA in [`script/env`](script/env). A `latest` tag means an unrelated push to someone else's master can turn this repo red with no commit of ours involved — and the failure will read as our regression.

## 7. Assert what the fixture proves, not what happens to be true

An assertion should fail when the product breaks and at no other time. Two traps this suite has already hit:

- **pinning one value from a set** — the fixture drives more than one endpoint, so "the newest trace is `POST:/users`" turns on traffic timing, not correctness. Match against the known set instead.
- **asserting a healthy state that is not the only healthy state** — "every template row is synced" was permanently false on a working system, because most rows are legitimately `remote-only`. Name the states that mean *breakage* instead.

When an expectation fails, the first question is whether the system is wrong or the expectation is. In this suite it has usually been the expectation.
