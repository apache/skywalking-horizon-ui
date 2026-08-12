# Themes and Global Defaults

Horizon ships five complete visual themes. Every user can pick their own from the topbar, and an administrator sets the organization-wide starting point — the default theme plus the default time window — on **Dashboard setup → Global defaults** (`/admin/global-defaults`).

## The five bundled themes

| Theme | Style | In a phrase |
|---|---|---|
| **Horizon** | dark · amber accent | The shipped SkyWalking NG look — dense, warm, observability-first. The default. |
| **Meridian** | dark · navy ground, indigo accent | A cooler, tightly packed variant for SREs who live in tables. |
| **Obsidian** | dark · true black, cyan accent | High-contrast, monospaced (IBM Plex Mono), pixel-precise readouts; comfortable on OLED. |
| **Daybreak** | light · violet accent | The one light theme — airy spacing and soft shadows, for shared screens and printouts. |
| **Aurora** | dark · magenta-to-cyan gradient | Glass-morphic showcase chrome, made for demos and product tours. |

A theme is a full design decision, not just a color swap: each one sets the background and text palette, accent and status colors, font, corner radius, and layout density, and declares itself dark or light overall (the logo and light-specific styling follow automatically).

Themes ship with the UI build — you pick one; there is no theme authoring surface.

## How the active theme is decided

Three tiers, top wins:

1. **Your personal pick** — set from the topbar theme chip, stored in this browser only.
2. **The org default** — set by an admin on the Global defaults page, stored on OAP, shared by everyone.
3. **The shipped default** — Horizon, used when neither of the above is set or reachable.

## Picking your own theme

The theme chip sits in the topbar's right cluster and shows the currently active theme's name. Click it to open the list of five themes; picking one applies instantly and sticks for this browser.

- A small dot on the chip means your personal pick differs from the org default.
- When you have no personal pick, the list marks the org default with an **(org default)** annotation.
- **Reset to org default** (shown only while you have an override) clears your pick and falls back to the shared default.

Personal picks live in the browser's local storage (`horizon:theme:user`), so they survive logout on the same browser but do not follow you to another device.

## Setting the org default theme

Open **Dashboard setup → Global defaults**. The Theme section shows all five themes as preview cards, each rendered in its own palette — typography sample, buttons, a mini chart, and the theme's font / radius / density / mode facts — so you can compare them without switching. The card marked **active** is what your own browser is showing right now; the highlighted card is your pending selection. Pick a card and **save to OAP**.

The org default is the starting theme every user sees on first visit. Users who have already set a personal pick keep it — saving a new org default does not overwrite personal overrides.

## Default time window

The same page's second section sets the default window for the topbar's global time picker — the range every dashboard and overview starts on.

- It applies to **dashboards and overviews only**. Triage pages (alarms, traces, logs, profiling, live debugger) own their own time range and always query at `SECOND` precision; they are not affected.
- It is a **starting point**, applied once when the app loads. Whatever a user then picks in the time picker stays sticky for their session, and **Save as my default** in the picker's menu stores a personal default (browser-local) that outranks the org value, with **Reset to org default** to clear it. Saving requires a rolling preset to be selected — a custom absolute range cannot be a default.
- The query `step` precision is derived from the window size — you don't pick it separately: up to 4 hours → `MINUTE`, under 30 days → `HOUR`, 30 days and longer → `DAY`. The page shows the resolved precision and bucket count for the value you're editing.
- The topbar picker itself offers fixed rolling presets (Last 5 minutes … Last 90 days), so the default window snaps to the nearest preset when applied. Choose one of the offered preset sizes (15 m, 30 m, 1 h, 2 h, 4 h, 12 h, 24 h, 7 d) for an exact match; a custom minute count (up to 44640, i.e. 31 days) is accepted but lands on the closest preset.

The shipped default is 60 minutes.

## Permissions

Seeing the Global defaults page requires the `setup:read` verb; publishing an edit requires `overview:write`. In the bundled roles both are held by **operator** (and **admin**). See [Roles and Permissions](../access-control/rbac.md).

## How the settings are stored

Both defaults are stored on OAP in the same template store as dashboards, under Horizon's reserved namespace — `theme` and `time-defaults` are two of the reserved template families alongside `overview`, `layer`, `alert`, and `infra-3d`. Each is a singleton row:

- `horizon.theme.active` — the org default theme.
- `horizon.time-defaults.global` — the default time window.

In live template mode the shipped values are seeded into OAP at first boot; saving on the Global defaults page overwrites the OAP row, and the OAP copy wins at render time. Because the rows live on OAP, the settings survive Horizon restarts and are shared by every Horizon instance pointing at the same OAP.

Each section carries the same sync-status badge as the dashboard admin pages. **diverged** simply means the OAP-stored value differs from the shipped default — the normal state once you've set your own org default. **show diff & reset** opens a side-by-side view of the shipped versus OAP-stored value and can reset OAP back to the shipped default after a typed confirmation.

The page is read-only in two situations: when Horizon runs in read-only template mode (`templates.mode: readonly`, see [Configuration File](../setup/horizon-yaml.md#template-source-mode)) the shipped values are used and nothing can be published, and when OAP's admin port is temporarily unreachable the page shows the current values but disables saving until OAP is back.

Unlike the dashboard admin pages, Global defaults has no file export/import — the two values are single fields; to replicate them on another deployment, set them there directly.

## Appendix: stored JSON

The OAP rows use the standard Horizon template envelope. The two singletons look like this:

```json
{
  "name": "horizon.theme.active",
  "kind": "theme",
  "version": 1,
  "content": { "themeId": "horizon" }
}
```

Valid `themeId` values: `horizon`, `meridian`, `obsidian`, `daybreak`, `aurora`.

```json
{
  "name": "horizon.time-defaults.global",
  "kind": "time-defaults",
  "version": 1,
  "content": { "defaultWindowMinutes": 60 }
}
```

`defaultWindowMinutes` is a positive integer number of minutes.
