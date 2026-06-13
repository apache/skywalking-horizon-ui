---
name: pull-request
description: Open a pull request for the current Horizon UI branch the right way — run the full preflight gate first (CHANGELOG + docs updated, type-check + build "compiling passed", new UI strings translated across all 8 locales, license headers, lint + unit tests, live-OAP validation), commit with NO AI trailers, push, and open the PR against apache/skywalking-horizon-ui. After it merges, return to main, fast-forward to latest, and delete the merged local branch.
user-invocable: true
---

# Open (and clean up after) a Horizon UI pull request

Use this when the developer asks to open a PR / push changes for review. The
preflight gate below mirrors what CI (`.github/workflows/ci.yaml`) will run, so
a green gate means a green PR. Run everything from the **repo root**.

## Ground rules (non-negotiable)

- **No AI attribution, ever.** Never add `Co-Authored-By: Claude` (or any
  AI / Anthropic / `noreply@anthropic.com` line) and never append the
  "🤖 Generated with Claude Code" footer to a commit message or PR body.
  This is a per-project directive in `CLAUDE.md`.
- **Never commit on `main`.** Branch first. `origin` is
  `apache/skywalking-horizon-ui`; committers push branches **directly** to it
  (no fork). Confirm you can with
  `gh api repos/apache/skywalking-horizon-ui -q .permissions` (look for
  `"push": true`).

## 1 — Preflight gate (do this BEFORE opening the PR)

Walk the list in order. Each item maps to a thing CI enforces or a thing a
reviewer will bounce the PR for. If you genuinely can't run one, say so in the
PR body rather than skipping silently.

### A. CHANGELOG updated
If the change is **operator-visible** — a new page / tab / widget, a new
component flag, a bundled-template change (a layer gaining a capability, new
dashboards / widgets / metrics), a new admin surface — add an entry under the
current **unreleased** (`*-dev` in `package.json`) section of `CHANGELOG.md`,
written from the operator's point of view. **One line per paragraph / bullet —
no hard wrap** (house style; see `CLAUDE.md`). Released version sections are
frozen (bug-fix entries only). A pure refactor / tooling / internal-docs change
gets **no** changelog entry.

### B. docs/ updated
If observable behavior or configuration changed, update the public docs under
`docs/` (end-user / operator POV — what it does, how to configure it, how to
operate it; never internal code narration). Flat layout, registered in
`docs/menu.yml`. Same one-line-per-paragraph house style.

### C. Compiling passed (type-check + build)
This is what "compiling passed" means here — CI runs `type-check`, `build-ui`,
`build-bff` as separate gates:

```bash
pnpm -r run type-check                              # vue-tsc + tsc, strict, no `any`
pnpm --filter @skywalking-horizon-ui/ui build       # vite build (UI)
pnpm --filter @skywalking-horizon-ui/bff build      # esbuild bundle (BFF)
```

### D. New UI strings are translated (all 8 locales)
A new on-screen string must not ship hardcoded or English-only.

- **UI chrome** strings live in `apps/ui/src/i18n/locales/<locale>.json`.
  **English (`en.json`) is the source of truth — author the key there first**,
  then add the *same* key with a real translation to every other catalog:
  `zh-CN, es, pt, ja, ko, de, fr`. A missing key silently falls back to
  English, so "did I actually translate it?" needs an explicit check:

  ```bash
  # Report en.json keys still missing from each non-English UI catalog:
  node -e '
  const fs=require("fs"),d="apps/ui/src/i18n/locales/";
  const flat=(o,p="")=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==="object"?flat(v,p+k+"."):[p+k]);
  const en=new Set(flat(JSON.parse(fs.readFileSync(d+"en.json"))));
  for(const l of ["zh-CN","es","pt","ja","ko","de","fr"]){
    const have=new Set(flat(JSON.parse(fs.readFileSync(d+l+".json"))));
    const miss=[...en].filter(k=>!have.has(k));
    console.log(l, miss.length?("missing "+miss.length+": "+miss.slice(0,8).join(", ")):"complete");
  }'
  ```

- **BFF-shipped template** strings (bundled layer / overview dashboards) are
  translated via sibling `*.i18n.<lang>.json` overlays, not the UI catalogs.
  Validate their structure (catalog drift = a key not in the source template is
  an error):

  ```bash
  pnpm --filter @skywalking-horizon-ui/bff run i18n:validate
  ```

- **Translation policy** (`CLAUDE.md`): translate *meaning*, not words. Product /
  protocol names, OAP scope enums (Service / ServiceInstance / Endpoint /
  Process), layer keys, MQE function names, metric ids, env vars, HTTP / SQL /
  log keywords stay **verbatim** in every locale. OAP-supplied data (service /
  instance / endpoint names, alarm rule names, log lines, span ops, tag values)
  is **never** translated. AI-seeded translations are acceptable to ship.

### E. License headers
Every new `.ts` / `.vue` / `.js` / `.mjs` / `.yaml` / `.yml` / `.css` / `.scss`
needs the Apache header (JSON / Markdown / lock files excluded):

```bash
pnpm license:check        # license-eye -c .licenserc.yaml header check
pnpm license:fix          # auto-insert any missing headers, then re-check
```

### F. Lint + unit tests
```bash
pnpm -r run lint
pnpm -r run test:unit
```

### G. Validate against a live OAP (when the change touches OAP wire/render)
A green type-check does **not** prove a feature works. If the change touches an
OAP query, a wire shape, a metric/MQE, or a rendered screen, boot against a real
OAP (`/local-boot` — demo or local) and confirm the actual request/response and
the rendered UI. "I couldn't validate against OAP" is an honest thing to put in
the PR; shipping an unvalidated wire change as "done" is not.

## 2 — Branch, commit, push

```bash
# Branch off main if you're on it (type: feat | fix | chore | docs | refactor):
git checkout -b <type>/<short-slug>

git add <only the files you changed>      # not a blanket `git add -A`
git commit -F - <<'MSG'
<type>(<scope>): <imperative subject>

<body: what changed and why, operator POV where relevant>
MSG
# ^ NO Co-Authored-By / AI footer.

git push -u origin <type>/<short-slug>
```

## 3 — Open the PR

```bash
gh pr create --repo apache/skywalking-horizon-ui \
  --base main --head <type>/<short-slug> \
  --title "<conventional-commit title>" \
  --body "$(cat <<'BODY'
## Why
<the problem / motivation>

## What
<the change, reviewer-facing>

## Validation
<type-check/build green; live-OAP render checked, or why not; i18n filled>
BODY
)"
```

No AI footer in the body. Capture the returned PR URL/number for step 4.

## 4 — After the PR is MERGED: return to main, update, delete the branch

Only run this once the PR actually shows `MERGED`. Don't assume — check.

```bash
PR=<number>; BR=<type>/<short-slug>

gh pr view "$PR" --repo apache/skywalking-horizon-ui --json state -q .state   # expect: MERGED

git checkout main
git pull --ff-only origin main          # main is the default branch — safe to fast-forward
git branch -d "$BR"                      # safe delete; only removes a fully-merged branch
# If it was SQUASH-merged, your branch commit isn't an ancestor of main, so `-d`
# errors "not fully merged". You already confirmed MERGED via gh above, so force it:
git branch -D "$BR"

git remote prune origin                  # drop the stale remote-tracking ref (GitHub auto-deletes the head branch on merge)
```

Gotchas:
- This repo's primary clone is sometimes parked on a feature branch on purpose.
  If you have other WIP, confirm before switching to `main` and deleting.
- If the remote head branch was **not** auto-deleted on merge and you want it
  gone too: `git push origin --delete "$BR"`.
