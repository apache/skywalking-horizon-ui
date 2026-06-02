# CLAUDE.md — Writing the Horizon UI docs

`docs/` is the **public website documentation** for Horizon UI — a flat tree,
ordered by `menu.yml`, synced to the Apache SkyWalking website. It is written
for the people who **run and configure** Horizon (operators, dashboard
authors), not for contributors hacking on the code. These are the principles
for every page here. For the project-wide rules, see the root
[CLAUDE.md](../CLAUDE.md).

## 1. Operator perspective first

Document what a feature **does**, how to **configure** it, and how to
**operate / troubleshoot** it — observable behavior and configuration.

Do **not** document the internals:

- no source-file paths (`apps/bff/src/…`, `apps/ui/src/…`),
- no internal function / composable / store / route-handler names,
- no implementation narration ("the BFF then chunks / fans out / probes …"),
- no step-by-step retelling of the code's algorithm.

If a sentence only makes sense to someone reading the source, it does not
belong in a doc.

**One carve-out: contributor pages.** A few pages document repo / file-based
authoring that has no UI path — adding a new layer template, contributing a
translation catalog or a new locale. These are explicitly contributor-facing
and may reference repo files, `pnpm` commands, and the dev workflow; keep them
scoped to that task. Today: `customization/adding-a-new-layer.md` and the
contributor sections of `customization/i18n.md`. Everything else stays
operator-facing.

## 2. Config is edited in the UI — lead with that; JSON is an appendix

Almost everything configurable in Horizon (layer dashboards, overview
templates, the 3D-map config, alarm-page setup, global defaults, translations)
is edited through a **structured / visual admin page**, on a bundled default →
local draft → **Check diff & push** to OAP flow. A configuration page should:

- **Start from the concept** — what this configuration is and what it controls.
- **Then the UI** — which admin page edits it and what the controls do.
- **Keep the JSON / schema as a reference appendix** at the end, framed as the
  *stored* format the editor reads and writes (useful for understanding the
  fields, or authoring as files), **not** as the primary "how to author" path.

There is **no raw-JSON editor on these pages.** Never tell the reader to "edit
the JSON" on a page — they use the structured controls. The Monaco view that
appears is a read-only **diff** for review before pushing.

## 3. Don't hardcode the Horizon version

The website serves these docs **pinned per release**, so a version string in
the body is redundant and silently goes stale on the next release. By default,
write version-neutral: use a `<version>` placeholder in install commands, or
phrase around it. State a concrete version only when the content is genuinely
version-specific (a compatibility note, or a "new in X" call-out you
deliberately want pinned).

The **one maintained exception** is `setup/container-image.md`: its image tags
track the current release and are advanced automatically by the release tooling
— leave them as concrete versions.

## 4. Other house rules

- **Tech terms and proper nouns stay verbatim** — SkyWalking, OAP, MQE, eBPF,
  Kubernetes, Istio, GraphQL, layer keys (`GENERAL`, `MESH`), scope enums
  (Service, Endpoint), metric ids. Don't translate or rename them.
- **Cross-link, don't duplicate.** One canonical page per concept; link to it
  rather than restating it.
- **Add new pages to `menu.yml`.** A page that isn't in the menu isn't
  navigable on the site.
