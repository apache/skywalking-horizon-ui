# Browser Logs & Source Maps

The **BROWSER** layer has a **Browser Logs** tab that lists the JavaScript
errors your browser agent reports — message, category (`JS`, `PROMISE`, `VUE`,
`AJAX`, `RESOURCE`), the page, the app version, and the minified `line:col`.
In production those positions point into minified, bundled code, so the stack
is unreadable. Upload the build's **source map** and Horizon resolves the stack
back to the original file, line, column, and symbol — with a source snippet.

## Viewing browser logs

Open the **BROWSER** layer and pick the **Browser Logs** tab. Choose an app in
the selector, then narrow with the **Version**, **Page**, and **Time range**
conditions. The list queries on demand: nothing is fetched until you press
**Run query**, so a freshly opened tab shows a *Pick your conditions, then
click Run query* prompt rather than auto-loading, and switching app resets to
that prompt (clearing the category filter). Once results load, the **Category**
legend above the stream filters them client-side (click a category to filter;
the counts stay visible). Each row is one reported error, newest first.

The **Time range** is owned by this page — the global topbar picker is paused
while you're here, so auto-refresh won't shift the window mid-investigation.
Pick a rolling preset (default **Last 30 min**) or a **Custom** absolute
start/end.

Click a row to expand it. The left side shows the **raw stack** as the browser
reported it; the right side is where you resolve it. An error's first
occurrence is flagged in that expanded detail.

## Resolving a minified stack

1. Make a source map available (upload it, or provision it statically — below).
2. Expand the error row.
3. Pick the map from the **source map** dropdown.
4. Click **Resolve**.

Horizon parses the stack, maps each frame through the chosen map, and shows the
original `file:line:column`, the original symbol name, and a few lines of
original source around each frame. The map you used is named above the result,
because **which map matches which build is your call** — see [Matching maps to
builds](#matching-maps-to-builds).

Source maps cover anything that compiles to browser JavaScript and ships a
standard source map: JavaScript, TypeScript, JSX/TSX, Vue, Svelte, and the
output of webpack, Vite/Rollup, esbuild, Babel, `tsc`, and minifiers. Code with
no source map, inline/`eval`-ed code, and WebAssembly can't be resolved.

Which **categories** carry a resolvable stack: **`JS`**, **`PROMISE`**, and
**`VUE`** are real JavaScript errors whose stack points into your bundle —
these resolve. **`AJAX`** and **`RESOURCE`** are network/load failures (a failed
request or asset), so their "stack" is an HTTP status or URL, not code — there
is nothing for a source map to translate. (Only the `JS` category reports a
top-level `line:col`; for the others the position lives inside the stack string,
which the resolver parses.)

## Two ways to provide maps

### Upload (temporary)

The **Upload .map** button on the tab loads a map into the server's memory for
immediate use. These uploads are **temporary by design**:

- They live in the server's memory only — there is no backend storage.
- They are evicted **least-recently-used** once the configured memory budget is
  reached, and they are **lost when the server restarts**.
- In a multi-instance deployment a map you upload is only visible on the
  instance that received it.

The tab shows current memory usage against the budget and warns that uploaded
maps are temporary. Use uploads for ad-hoc triage.

### Static mount (durable)

For durable provisioning, place `.map` files in the server's **source-map
directory** and they're indexed at boot. Each file is validated as a Source Map
v3 at index time, so only real maps appear in the picker (others are skipped
with a log warning), and the directory is bounded by `maxFileCount` — beyond it,
extra files are skipped. Mounted maps survive restarts, reload on demand, and
can't be deleted from the UI. In the container image the directory is
`/app/sourcemaps` (set by `HORIZON_SOURCEMAPS_DIR`); bind-mount or copy your
build's maps there. See [Container Image](../setup/container-image.md).

## Matching maps to builds

A source map only resolves correctly against the **exact build** it was
generated from. The browser agent reports an app **version** but no build
fingerprint, so Horizon does not auto-pick a map — **you choose** which map to
apply, and the resolved view names it so you can confirm. Applying a map from a
different build yields confidently wrong line numbers, so keep your maps
labelled by version and pick the one that matches the error's app version.

> Source maps' `sourcesContent` embeds your original source code. Treat the
> maps you upload or mount as sensitive, and provision them only on servers you
> trust.

## Configuration

Budgets and the static directory are set in the `sourceMaps` block of
`horizon.yaml`:

```yaml
sourceMaps:
  enabled: true              # turn the upload/resolve controls on or off
  maxFileBytes: 67108864     # 64 MiB — reject any single .map larger than this
  maxTotalBytes: 536870912   # 512 MiB — resident-upload budget (LRU-evicted past it)
  maxFileCount: 128          # per-set map cap — the uploaded set and the mounted set are each bounded by this
  bootMountDir: /app/sourcemaps   # static .map directory scanned at boot ("" disables it)
```

`maxTotalBytes` bounds the **resident uploaded maps** (raw `.map` bytes held in
memory). A single upload larger than it is rejected; past it, the
least-recently-used uploaded maps are evicted. On top of that, a few
recently-resolved maps are kept **parsed** (bounded to a small count) — parsed
structures run larger than the raw file, so size the container with headroom
(≈2× the budget is comfortable). Mounted maps are disk-backed and don't count
against this budget. Size `maxTotalBytes` against the memory available to the
server — maps with `sourcesContent` are commonly tens of MiB each. When
`enabled` is `false`, the tab still lists errors but the map controls are hidden.

> **Restart-only knobs.** `enabled`, `maxTotalBytes`, and `maxFileCount` apply
> live on a config reload — lowering a budget trims the **uploaded** set on the
> next upload / resolve / list (least-recently-used first). Maps already loaded
> from the mount are fixed by the boot scan: lowering `maxFileCount` afterwards
> won't shrink the mounted set (restart to re-scan the mount against the lower
> count). Two changes need a restart: `bootMountDir` (the directory is scanned
> once at startup, so changes — and newly-dropped `.map` files — take effect on
> restart), and **raising** `maxFileBytes` (the upload size limit is fixed at
> startup; lowering it applies live).

**Hot reload.** `enabled` and the budgets take effect immediately on a
`horizon.yaml` change — with one exception: the upload size limit is fixed when
the server starts, so *raising* `maxFileBytes` to accept a larger upload needs a
restart (lowering it, and toggling `enabled`, apply live).

## Permissions

| Action | Permission |
|---|---|
| View logs, list maps, resolve a stack | `browser-errors:read` |
| Upload or remove a source map | `source-map:write` |

The default **viewer**, **maintainer**, and **operator** roles can read and
resolve; **operator** (and **admin**) can upload and remove. See
[Roles and Permissions](../access-control/rbac.md).
