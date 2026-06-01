# CLAUDE.md — 3D Infra Map (`/3d/map`)

This file documents the design rules for the 3D infra map feature. The
code is the source of truth; this document captures the **intent** so
future changes preserve the visual grammar instead of accidentally
breaking it.

## Goal

A spatial summary of "what's deployed, in which tier, talking to what."
Not a replacement for the per-layer service-map page — a single view
that lets an operator see the **shape of the deployment** across
application, service-mesh, and infrastructure tiers at once.

## Tech stack

- **Three.js** (MIT, ASF Cat A) — the WebGL engine.
- **TresJS** (MIT) — Vue 3 declarative wrapper over Three.
- **`@tresjs/cientos`** (MIT) — `OrbitControls`, `Html` portals.
- **d3** — only the `d3-scale` / array helpers; layout is hand-rolled.

All resources (geometries, materials) are **shared** across nodes of
the same kind and disposed on unmount. Animation is per-frame on the
`<TresCanvas @loop>` event — no `useLoop` composable, no inner scene
component, no need to render-on-demand for the PoC (continuous render
is fine for the dedicated route).

## Layout — the load-bearing rules

### Three tier-planes (vertical Y)

| Plane | Y | Contains | Layer mapping |
|---|---|---|---|
| `apps` (top) | 16 | application services, browser RUM, mobile, virtual targets, self-observability agents | `general`, `browser`, `ios`, `*_mini_program`, `virtual_*`, `so11y_*` |
| `mesh` (middle) | 8 | service-mesh sidecars and control planes | `mesh`, `mesh_cp`, `mesh_dp`, `cilium_service`, `envoy_*` |
| `infra` (bottom) | 0 | everything else: K8s, VM, databases, MQ, caches, gateways, cloud, FaaS | the catch-all |

The mapping is in `planeForLayer()` in `composables/useMapTopology.ts`.
A layer **belongs to exactly one plane**. Adding a new layer means
adding one branch to that function — not introducing new planes.

### Zones on a plane

Each plane is subdivided into **zones**, one per active layer
(layers with zero services on this OAP deployment are dropped, not
shown as empty zones). A zone is a colored translucent rectangle on
the plane.

Within a plane, zones are arranged by an **inside-out** rule:

1. **Center**: layers that carry a service-map (`callEdges.length > 0`),
   sorted by service count desc. These are the layers the operator's
   eye should go to first.
2. **Sides**: every other layer, sorted by service count desc,
   interleaved alternately left / right of the center so the visual
   weight stays balanced.

Result for the showcase demo:
- `apps` plane: `general` (5 svc, topo) sits at center; `mesh` is on
  the `mesh` plane (different plane). The other apps layers
  (`browser`, `so11y_*`, `virtual_*`) tile around `general`.
- `mesh` plane: `mesh` (9 svc, topo) sits at center; `mesh_dp` and
  `mesh_cp` tile on the sides.
- `infra` plane: `k8s_service` (35 svc, topo) sits at center;
  databases (`mysql`, `postgresql`), MQ (`activemq`), and `k8s` tile
  on the sides.

### Node layout inside a zone

Two algorithms, picked by whether the layer has a topology snapshot.

#### A — Layers with topology: rank-based grid (Sugiyama-lite)

For the three layers that ship a service map (`general`, `mesh`,
`k8s_service` in the demo), nodes are laid out as a **column-per-rank
grid** — the 3D analogue of the 2D booster-ui service map:

1. **Rank** = longest call-path from any source node (a node with no
   incoming edges). Computed by a relaxation pass that is bounded by
   N iterations so cycles don't loop forever. Unreached nodes (orphan
   or cycle-only) fall to rank 0.
2. **Within-rank order** = one-pass median heuristic. For rank
   R ≥ 1, nodes are ordered by the median index of their incoming
   neighbours in rank R − 1. Ties keep the source order (stable
   across reloads).
3. **Position** = `x = (rank − (cols−1)/2) · stride`, `z = (within −
   (rank.size−1)/2) · stride`. Each column is vertically **centered**
   on the rank-band midline so a 3-node column next to a 5-node
   column reads as concentric, not bottom-aligned.

This produces a clean rectangular matrix that reads left-to-right
(upstream → downstream). Edges between nodes within the zone are
drawn as arcs above the plane.

#### B — Layers without topology: column-fill grid

For everything else, nodes are placed by a deterministic
**column-fill** rule (vertical-first):

1. Find the smallest `rows` such that `rows × (rows − 1) ≥ n`. For
   `n ≤ 3`, degenerate to a single column (`rows = n`, `cols = 1`).
2. `cols = ⌈ n / rows ⌉`.
3. Fill columns left-to-right, each up to `rows` cubes. The last
   column may be shorter.

The constraint `cols ≤ rows − 1` keeps the layout **taller than wide**
— a column of stacked cubes is a natural shape on a horizontal plane
and avoids long thin strips. Worked examples:

| n | rows | cols | Distribution |
|---|---|---|---|
| 1 | 1 | 1 | `1` |
| 2 | 2 | 1 | `2` |
| 3 | 3 | 1 | `3` |
| 4 | 3 | 2 | `3, 1` |
| 5 | 3 | 2 | `3, 2` |
| 6 | 3 | 2 | `3, 3` |
| 7 | 4 | 2 | `4, 3` |
| 8 | 4 | 2 | `4, 4` |
| 9 | 4 | 3 | `4, 4, 1` |
| 10 | 4 | 3 | `4, 4, 2` |
| 11 | 4 | 3 | `4, 4, 3` |
| 12 | 4 | 3 | `4, 4, 4` |
| 13 | 5 | 3 | `5, 5, 3` |
| 35 (k8s) | 7 | 5 | `7, 7, 7, 7, 7` |

### Zone footprint

Zone width/depth is **derived from the layout's bbox**, not the other
way round. Constants:

- `CELL_STRIDE_X = 2.4` — horizontal gap between cubes on the grid.
- `CELL_STRIDE_Z = 2.4` — vertical gap between cubes on the grid.
- `ZONE_INNER_PAD = 1.2` — cubes stay clear of the colored zone edge
  by this much.
- `ZONE_GAP_X = 2.4` — horizontal gap between adjacent zones on the
  same plane.

So:

- `zone.width = bbox.width + CELL_STRIDE_X + 2 · ZONE_INNER_PAD`
- `zone.depth = bbox.depth + CELL_STRIDE_Z + 2 · ZONE_INNER_PAD`

The plane width is then `Σ zone.widths + (N − 1) · ZONE_GAP_X + 4`,
and the plane depth is `max(zone.depths) + 2`. Planes are **not**
forced to share a width — operators expect the infra plane to be
wider than the apps plane (more layers, more services).

### Edges

| Kind | Rendering | Data source |
|---|---|---|
| **Intra-zone call** | dim white arcs above the plane, with neutral packets animating along them | the per-layer service-map snapshot (`topologies.<layer>.calls`), filtered to calls where **both** endpoints are services in this layer |
| **Cross-plane hierarchy** | NOT rendered in the static view | held in the graph data (`SceneGraph.hierarchyEdges`) for a future hover-to-reveal interaction; do not render unprompted, it clutters the static view |

Cross-layer call edges (e.g. `general/agent::songs → virtual_mq`) are
deliberately dropped — they belong to a future interaction layer
("trace a call across tiers"), not the always-on visual.

### Camera

- `OrbitControls` with rotate, zoom, and **pan** all enabled. Pan is
  important: clicking a node recenters the orbit target, but
  operators also want to drag-pan for free exploration.
- `min-distance = 8`, `max-distance = 240`. Polar angle capped at
  ~88° from vertical so the camera can't go below the planes.
- Default pose: `~30° elevation` isometric framing of the centroid
  of the placement bounds.
- **Click semantics are split**: clicks IN THE 3D SCENE never move
  the camera — they're selection-only. Clicks on the SIDE PANEL
  (or the toolbar / keyboard) are the camera-move surface. This
  split is load-bearing: a previous build glided the camera on
  every cube click, which made selection feel unreliable (the cube
  animated out from under the cursor between `pointerdown` and
  `pointerup`, the hover state flickered, and the operator saw "I
  have to click twice").
  - **Cube click** → select the service, show the detail card.
  - **Zone plane click** (empty space on a colored tile) → clear
    any existing selection. Lets the operator dismiss the detail
    card without aiming at the small × button.
  - **Side-panel layer row click** → lerp the camera target to
    that zone's center. The ONE click-driven camera move.
  - **Side-panel eye button** → toggle that layer's visibility,
    independent of camera position. The scene lerps the orbit target toward this target
  on each frame (`k = δ · 6`, frame-rate-independent ease) so the
  camera **glides** rather than teleports.
- **Top-left toolbar**: explicit buttons for zoom (`＋` / `−`),
  rotate-around-Y (`↺` / `↻`), 4-way pan, and reset (`⌂`). They
  drive the same scene methods (`zoom`, `rotateY`, `pan`,
  `resetView`) that the mouse gestures use, exposed via
  `defineExpose`. The buttons are discoverability + trackpad
  ergonomics — mouse gestures still work in parallel.
- **Keyboard pan**: arrow keys + `WASD` pan the orbit center along
  the camera's screen-relative axes. Hold `Shift` for a 3× step.
  Bound on `window` so the keys work without first clicking the
  canvas; suppressed when focus is in an `<input>` / `<textarea>` /
  contenteditable so future inputs in the chrome aren't hijacked.
- **The Scene → OrbitControls plumbing**: the scene reads and
  mutates the THREE camera + OrbitControls instances directly via
  template refs, NOT through reactive Vue props. Vue's `:position`
  / `:target` bind once on mount and after that all updates go
  through the live THREE objects. This is load-bearing: a Vue
  reactive prop bound to a static value would stomp every
  mouse-driven pan back on the next diff, AND a Vue-reactive
  Vector3 wrapper would itself be stale relative to the live
  OrbitControls target. The instance access goes through
  `getControls()` / `getCamera()` which handle both
  ref-auto-unwrap and explicit-ref shapes — cientos's
  `__expose({ instance: shallowRef })` is auto-unwrapped by Vue's
  expose proxy, so `componentRef.value.instance` returns the
  THREE.OrbitControls directly.

### Zone label auto-hide on zoom-out

When the camera zooms out far enough that the zone label's pixel
width would exceed the zone's projected pixel footprint, the label is
hidden. This avoids the "labels overflow their tile" mess on a
zoomed-out view.

Implementation:

- Approximate the label's rendered width from the layer name's
  character count + a constant for the level chip + topology pill.
  Cheap heuristic; the visual decision only needs a coarse number.
- Project the zone's two horizontal extremes (`centerX ± width/2`)
  through the camera each frame; the X-NDC delta times half the
  canvas width gives the zone's pixel width.
- Throttled to ~6 Hz — running it every frame for every zone is wasted
  work since the operator can't perceive a sub-100ms toggle.
- The result is committed to a reactive `hiddenLabels: Set<layerKey>`
  only when the set actually changes, so no unnecessary re-renders.

### Materials and color

Every layer carries a **tint** (`ZoneTint`) — a category drawn from
`tintForLayer()`. The tint resolves to a CSS custom property via
`tintCssVar()`, which is read once into a Three `Color`. This keeps
the 3D scene and the side-panel swatches in lockstep with the design
tokens.

| Tint | CSS var | Layers |
|---|---|---|
| `app` | `--sw-accent` | `general` |
| `browser` | `--sw-cyan` | `browser` |
| `mobile` | `--sw-info` | `ios`, `*_mini_program` |
| `virtual` | `--sw-warn` | `virtual_*` |
| `so11y` | `--sw-purple` | `so11y_*` |
| `mesh` / `mesh-dp` | `--sw-purple` | `mesh`, `mesh_dp` |
| `mesh-cp` | `--sw-info` | `mesh_cp` |
| `cilium` | `--sw-cyan` | `cilium_service`, `envoy_*` |
| `k8s` | `--sw-ok` | `k8s*` |
| `vm` | `--sw-fg-2` | `os_*` |
| `db` | `--sw-warn` | `mysql`, `postgresql`, `mongodb`, `clickhouse`, `elasticsearch` |
| `mq` | `--sw-accent-2` | `kafka`, `rocketmq`, `rabbitmq`, `activemq`, `pulsar`, `bookkeeper`, `flink` |
| `cache` | `--sw-err` | `redis` |
| `gateway` | `--sw-info` | `apisix`, `kong`, `nginx`, `envoy_ai_gateway`, `faas`, `virtual_gateway` |
| `cloud` | `--sw-fg-3` | `aws_*` |
| `misc` | `--sw-fg-2` | anything else |

The tier-plane itself is the **neutral slate** (`#151a23`, 55%
opacity) — the colored zone sits on top of that. This way the
operator's eye picks the tier (Y position) first, then the zone (XZ
color), then the cubes (size, hover state).

### Side-panel layer rows

Each row in the right-side panel carries: a color swatch (the zone
tint), the layer name, a service count, and an **eye toggle**. The
panel follows design-tool convention (Sketch / Figma layer panel):

- **Click the row** (anywhere except the eye button) → recenters the
  camera on that zone. Most discoverable interaction; matches what
  clicking a layer rectangle in the 3D scene does.
- **Click the eye icon** → toggles that single layer's visibility.
  When hidden, the cubes + intra-zone arcs disappear and the row
  greys out. The eye glyph itself flips to "eye + slash" so the
  toggle direction is obvious without reading the tooltip.
- Whole-tier hide: clicking the plane header (`Apps · Browser ·
  Virtual` / `Service Mesh` / `Infrastructure`) toggles every layer
  in that plane at once.

### ⚠ See-through picking is a common 3D pitfall — DO NOT forget this

`THREE.Raycaster` ignores 2D screen-space occlusion. When you "see"
that cube B is hidden behind plane P because the plane covers it on
screen, the raycaster doesn't agree — it only cares whether the
ray from camera through cursor intersects each mesh's geometry. So
if you disable `raycast` on plane P (so it can't absorb clicks), a
cube directly behind P **is still pickable through the plane**.
The operator sees the front (occluded) cube turn its hover state
on, or click-selects something they can't even see.

The cure is the OPPOSITE of intuition: **leave raycast enabled on
opaque-ish layers that should occlude, even if they have no click
handler**. A plane without a handler that absorbs the raycast just
drops the click (no-op) — which is also the correct empty-space
behaviour. The only meshes that should opt OUT of raycasting are
genuinely DECORATIVE geometry that flies in front of cubes (traffic
packets, call-edge tubes): those would steal clicks aimed at the
cubes behind them without offering anything in return.

Current split:

| Mesh kind | raycast | Why |
|---|---|---|
| Service cubes | enabled (default) | they're the only pointer targets |
| Tier planes | **enabled** | occlude cubes behind them; absorb empty clicks harmlessly |
| Zone (layer) planes | **enabled** | same as tier planes |
| Call-edge tubes | disabled (`:ref` callback → `mesh.raycast = noop`) | decorative, fly in front of cubes |
| Traffic packets | disabled (same) | decorative, animate fast in front of cubes |

When you add a new mesh kind, ask: "if this mesh is between the
camera and a cube, should it block picking the cube?" — if yes,
leave raycast on. If no (it's a particle / animation / overlay),
disable it. The default is RAYCAST ENABLED for everything; explicit
disable is the special case.

### ⚠ TresJS listener accumulation — inline arrow handlers in v-for

TresJS's `nodeOps.patchProp` registers event listeners with
`node.addEventListener(type, fn)` on every prop patch — but it never
`removeEventListener`s the previous one. THREE's `EventDispatcher`
dedupes by reference only:

```js
if (listeners[type].indexOf(listener) === -1) {
  listeners[type].push(listener);
}
```

So passing a **fresh arrow function on every render** —

```html
<!-- DON'T do this on a v-for of TresJS elements -->
<TresMesh v-for="n in nodes" @pointerdown="() => onNodeClick(n)">
```

— is a NEW reference each render. THREE adds it as another listener
while the old ones linger. After N renders the mesh has N pointerdown
listeners; ONE pmndrs dispatch fires all N callbacks. Symptoms:

- Hover/click logs flood with N copies after a few seconds
- `emit('select', node)` fires N times for a single click → parent's
  toggle handler ends up at "deselected" on even N, "selected" on
  odd N — a parity gamble. The visible bug: click does nothing.

**The fix is a stable handler cache keyed by node id:**

```ts
const nodeHandlerCache = new Map<string, NodeHandlers>();
function nodeHandlers(node: SceneServiceNode): NodeHandlers {
  let h = nodeHandlerCache.get(node.nodeId);
  if (!h) {
    h = { pointerdown: () => onNodeClick(node), … };
    nodeHandlerCache.set(node.nodeId, h);
  }
  return h;
}
```

Template:

```html
<TresMesh v-for="n in nodes" v-on="nodeHandlers(n.node)">
```

Same function reference every render → THREE's `indexOf` check sees
"already registered" → listener count stays at one.

Single-instance TresJS elements (TresCanvas's `@loop`, `@pointermissed`
etc.) are safe because their handlers come from `<script setup>` as
stable function references; only v-for'd TresJS elements with inline
arrow handlers exhibit the accumulation.

### Picking — keeping cube clicks reliable

Cube clicks fail when something in front of the cube absorbs the
pointer event. We've hit and fixed THREE flavours of this:

0. **cientos `<Html>` wrapper absorbs `click`.** `<Html>` portals
   your content into the page DOM at the mesh's projected screen
   position. The wrapper div carries `pointer-events: auto` by
   default — so even when the inner content is `pointer-events:
   none`, the wrapper itself eats pointer events at the cursor
   position. The cube's `mousedown` may land on the canvas, but
   when the wrapper moves over the cursor between down and up
   (camera nudges, reactive re-render), `mouseup`'s `target`
   becomes the wrapper DIV. Browser dispatches `click` to whichever
   element matched both down + up — they no longer match, so
   `click` is never dispatched to the canvas, and pmndrs/TresJS
   never sees the click. **Fix: pass `:pointer-events="'none'"`
   to every informational `<Html>` (hover tooltip, zone labels,
   plane labels). Leave it `auto` ONLY for `<Html>` portals that
   contain real clickable UI (the detail card with its × and
   "open in layer" link).**

   This was the most insidious of the three — `pointer-events:
   none` on the inner `.floating-tip` was NOT enough. The
   cientos wrapper itself needs its own opt-out via the
   component's `pointer-events` prop.

   Critically: **use the cientos `pointer-events` prop, NOT a CSS
   class via `wrapper-class`.** Cientos applies `pointerEvents` as
   an INLINE style on the wrapper (specificity beats any external
   class), so trying to override via `.my-class { pointer-events:
   none }` does nothing. The right form is the prop itself:

   ```html
   <Html pointer-events="none" …>
   ```

1. **DOM-overlay labels** sat at the front edge of each zone in
   screen space — directly between the cursor and the cubes behind
   them. With cientos `<Html>`'s default `pointer-events: auto`,
   clicks meant for cubes silently landed on the label. Fixed by
   `pointer-events: none` on `.zone-label` and `.plane-label`.

2. **Decorative scene geometry** (traffic packets, call-edge tubes,
   zone backplates, tier backplates) still wins the raycast when
   something happens to be in front of the cube — packets are 0.18
   radius and animate constantly, so they intercept clicks at
   surprisingly high rates. Fixed by overwriting `mesh.raycast`
   with a no-op via a **template-ref callback**:

   ```html
   <TresMesh :ref="(el) => disableRaycast(el)" …>
   ```

   Do NOT use `:raycast="noRaycast"` as a prop — TresJS treats
   method-shaped props as *invocations*, not assignments. It would
   call `mesh.raycast(fn)` (passing the no-op function as the
   raycaster argument) and crash inside `Ray.copy(undefined)` the
   moment the canvas mounts. The function-ref pattern hands us the
   underlying THREE.Mesh directly so we can assign its `raycast`
   property cleanly.

After both fixes, only service cubes receive pointer events from the
3D scene. Side panel rows + the toolbar are the rest of the
interaction surface.

### Click discrimination — cube vs. empty space

Clicking outside any cube should clear the current selection. The
flow:

1. DOM `pointerup` on the canvas.
2. TresJS raycasts. If a cube is hit, its `@click` runs synchronously
   and stamps `lastCubeClickAt = performance.now()`.
3. The browser fires the DOM `click` event next, which bubbles to
   `.canvas-host`. The handler there checks the timestamp — if a
   cube absorbed the click within the last 80 ms, the canvas click
   is treated as already-handled. Otherwise it emits `select(null)`
   and the parent clears the selection.

This avoids putting `@click` handlers on the zone or tier planes
(which earlier caused mis-clicks aimed at small cubes to silently
deselect — frustrating). The empty-space detection is purely
temporal.

### Hover / select feedback

Cubes show three visual states with the SAME geometry — only the
material + scale change:

| State | Material | Scale |
|---|---|---|
| Default | Lambert in the zone tint | 1.0 |
| Hover | Lambert lerped 55% toward white, emissive tint at 0.7 | 1.1 |
| Selected | Lambert in accent orange, emissive at 0.85 | 1.18 |

The geometry is intentionally NOT swapped on hover (a previous
version did this; swapping the THREE geometry rebuilt the
raycaster's bounding box mid-pointer-event and made clicks miss /
require a second tap). Same single `BoxGeometry` for every cube;
every transition is a property change on the existing mesh.

## Live data vs. the snapshot

The scene now reads its structure live from OAP by default: the pipeline's
`services` / `topologies` stages fetch each layer's roster + service map one
at a time (`useLiveTopology.ts`), assembling a `MapTopology` that
`buildSceneGraph` consumes exactly like the snapshot. `data/fallback-topology.json`
remains the **fallback** — rendered until the first sequential load lands, if
the load comes back empty, or when `?live=0` forces it for comparison. The
scene is re-keyed on a per-layer structure hash so an unchanged refresh keeps
the camera; only a roster/edge change rebuilds. The cross-layer hierarchy
(`hierarchy`) is fetched live by the `hierarchy` stage (`loadLiveHierarchy`,
`getServiceHierarchy` per service) — **incrementally**: only newly-appeared
services are probed each refresh, the rest reused from a persistent cache, so a
steady roster costs zero hierarchy calls. The selected cube reveals its peers
from this data.

## What this PoC is NOT

- **Not** showing cross-plane edges as static geometry — that's a
  future interaction.
- **Not** persisting visibility / camera state across reloads.
- **Not** the canonical service-map. The 2D per-layer page is the
  authoritative one; this view's purpose is the **bird's-eye spatial
  summary**.

## Adding a new layer

1. The layer needs to appear in OAP's `listLayers` AND have at least
   one service (zero-service layers are filtered out of the snapshot).
2. Add a branch to `planeForLayer()` if the default ("infra") is
   wrong.
3. Add a branch to `tintForLayer()` if the default `misc` swatch is
   wrong.
4. If the layer template carries a `topology` component, the
   snapshot script (the one-off Python in this conversation) will
   pick it up automatically.

## Adding a future interaction

The hover-to-reveal-hierarchy interaction is the next obvious one. The
data is already in `graph.hierarchyEdges`. To wire it up:

1. On node hover, compute the subset of `hierarchyEdges` touching the
   hovered node.
2. Render their curves with the orange `hierarchyEdgeMat` (already
   defined and disposed) — keep the call-edge material for the
   intra-zone arcs.
3. Clear on hover-out.

Do **not** render hierarchy edges in the always-on view. The
operator's first encounter with this page should read as "three
tiers, each with its services" — adding 50+ vertical curves on top
turns that into noise.
