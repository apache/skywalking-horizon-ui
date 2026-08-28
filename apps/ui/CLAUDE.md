# CLAUDE.md — the UI's conversation with the BFF

The sibling of [`apps/bff/CLAUDE.md`](../bff/CLAUDE.md), which covers the leg below this one. That file is about what the BFF may ask OAP; this one is about what a screen may ask the BFF, and what it owes the operator when the answer is imperfect.

Principles only. Which fields a route returns, what a composable is called, how a component is wired — read the code.

## One door

Every request goes through the façade in `api/`, as `bff.<scope>.<method>()`. Adding a `fetch()` elsewhere is not a shortcut — it is a request that skips the session handling, the locale header, the cold-stage header and the cancellation the façade attaches to everything. A screen that needs something the façade does not expose gets a method on the right scope, not a private call.

There is **one** direct `fetch` in the app, and it is worth knowing why: the AI chat streams tokens, so it needs the raw `Response` body to read as it arrives, while the façade's whole contract is that it hands back parsed JSON. It pays for the exception by re-attaching by hand what it stepped outside of — credentials and the locale header — which is the argument against a second one.

The scopes are not organised by screen, and several screens legitimately share one. The map below says where each is read today, so a change to a scope can be checked against everything that would feel it:

| Scope | Read by |
|---|---|
| `session`, `oauth`, `oidc` | sign-in (`features/auth`), the auth store |
| `menu` | sidebar layers, OAP info, admin-feature gating (`shell/`) |
| `overview` | the overview renderer, and its admin editor |
| `layer` | the layer shell's landing / services / instances / endpoints, both maps, layer dashboards, **and the overview renderer** |
| `trace`, `zipkin` | the Traces tab, plus trace popouts from other screens |
| `log`, `browserErrors` | the Logs, Pod logs and Browser errors tabs |
| `events` | the Events page |
| `profile`, `ebpf`, `networkProfile`, `asyncProfile`, `pprof`, `continuousProfiling` | the profiling tabs, and the AI chat's proposal blocks |
| `alarms` | the Alarms page, the dashboard alarms widget, the 3D map, the sidebar count |
| `dsl`, `liveDebug`, `inspect`, `explore`, `oapOps` | the Operate sub-features |
| `infra3d` | the 3D infrastructure map |
| `layerTemplates`, `templateSync`, `configs` | the admin editors, plus the layer shell and the app-level config bundle |
| `adminAudit`, `adminAuth`, `adminUsers` | the admin pages |
| `ai` | the AI chat |

`layer` is the one worth reading twice. It serves the layer shell AND the overview renderer, so a change there lands on two screens that look nothing alike — see below.

## The landing route answers two screens

`layer.landing` is read by the layer shell's header and by every overview widget group, and they ask it differently:

- The **layer header** asks for the metrics the layer template declares under `layer-header.columns`, per service, and gets back a ranked service table plus the KPI strip above it.
- The **overview** synthesises its own columns from its widgets and marks them self-aggregating, so the whole layer folds to one scalar per KPI server-side. It fans out over nothing and its cost does not grow with the service count.

**The hourly figures are opt-in, and only the header opts in.** A request says
`hourlyKpi: true` to ask for the completed hour instead of the window it sent.
Only the layer header sends it, because it is the only screen that prints the
hour beside the numbers. Deciding it from the expressions instead — "this MQE
matches a header column, so serve the hour" — hands hour-old figures to any
caller whose expression happens to match, under a `durationStart` naming the ten
minutes it actually asked for. The Overview's page-side widgets are exactly that
caller.

Two more consequences for anyone editing either side. A column that carries its own MQE is naming an expression to evaluate, not a metric the layer must already know — refusing those emptied every overview KPI once. And the header's numbers come from **one completed hour**, held server-side, while everything else on the page follows the time picker: the response says which hour, and a header that renders the values without that label is claiming they are current when they are up to two hours old.

## Honest degradation is the caller's job

The BFF answers partially rather than failing outright, and every one of those signals is only worth having if a screen renders it. Swallowing one turns a known-incomplete answer into a confident wrong one — a chart that says zero, a roster that says the layer is empty, a KPI that looks live.

So: when a response carries a field describing how complete it is — which hour the values are from, whether they are the hour being replaced, how much of a fan-out failed, whether the last read reached OAP at all — the screen shows it. Not in a console warning; on the screen, where the person reading the number is.

The corollary is that a screen must not invent completeness either. Values retained from a previous read are drawn where they were actually read, never stretched to the current axis beside fresh ones.

## Cancellation

A read carries the round's `AbortSignal` all the way to the façade. A read the operator walked away from still costs OAP the whole fan-out, multiplied by the node count on a cluster, and the refresh round's cap stops the browser waiting without stopping any of that. Threading the signal is what actually stops it.

Anything that CHANGES something — creating a profiling task, pushing a template, saving config — does **not** take one. A closed tab must not leave a mutation half applied.

## Time

Two clocks, and they are not interchangeable. The topbar's range drives layer dashboards and overviews. Triage screens — alarms, traces, logs, profiling, the live debugger — own their own range and must not subscribe to the global ticker; an operator narrowing a trace search does not expect the next refresh tick to widen it again.

A range only reaches OAP when the composable forwards it AND the route accepts it. Verify the request that goes out, not the intent of the code that builds it.

## Cold stage is one header, and the BFF owns the scope

The UI sets `X-Horizon-Cold-Stage` once, centrally, for every request. It does **not** decide per endpoint which reads are cold-capable — the BFF holds that scope, and it is deliberately narrower than the protocol allows. A screen that wants to opt out of cold does not strip the header; the scope is changed on the BFF side, where the reason for it lives.

Turning the pill on does not re-read the page. It changes what the next read asks for. In-flight requests are cancelled so no batch is left half hot and half cold, but nothing is re-queued.

## Cascade-clear, then load

When an upstream control changes — service, instance or endpoint pick, time range, layer or scope navigation — the dependent area RESETS visibly and says it is reading, before the new values arrive. Leaving the previous value under a spinner is read as the new state, and an operator trusts it. Leaving the page silent between the click and the result reads as a freeze.

Each control owns its own reset and its own indicator, and resolves as its query lands. This is the display-layer half of the rule that gates `enabled` in the data layer.

## Layering

`api/` is the only path to HTTP. `shell/` knows about layers and routes, never about a feature's data. `controls/` owns the time range and the refresh ticker; pages subscribe and never own them. `state/` is global Pinia that survives navigation. `features/<feature>/` and `layer/<tab>/` are self-contained — views, composables and components together. `render/` is template-driven and generic. `components/{primitives,charts,icons}/` is feature-AGNOSTIC: the moment a shared component needs feature data, it moves into the feature rather than the shared pile growing a special case.

**Features do not import from each other**, and the exceptions today say what the rule is for rather than weakening it. `Modal` and `MonacoDiff` sit under `features/operate/_shared/` and are borrowed by admin and events — they are primitives in everything but their address, and moving them is a tidy-up nobody has done. The admin editor for the 3D map reads that feature's own config composable, which is a page editing the thing it is the editor for. Neither is one feature reaching into another's *data*, which is what the rule exists to stop.

**A chart component owns its ECharts instance; a VIEW never creates one.** Most go through the shared wrappers in `components/charts/`; a couple of chart types specific to one feature have their own component beside that feature, which is the same rule applied to a component that knows a feature's shape. What is banned is a view calling `echarts.init` inline, because then nothing owns disposal or theming. D3 lifecycles belong to a composable that tears down on unmount.
