<!--
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements.  See the NOTICE file distributed with
this work for additional information regarding copyright ownership.
The ASF licenses this file to You under the Apache License, Version 2.0
(the "License"); you may not use this file except in compliance with
the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->
# 3D Infrastructure Map

A single WebGL view of your whole deployment, stacked in 3D. Every
SkyWalking layer's services become cubes, grouped onto horizontal
**tiers**, with live traffic, alarms, and call relationships drawn
between them. It is the "stand back and look at everything at once"
companion to the per-layer dashboards.

Open it from the **3D Infra** pill in the topbar, or go directly to
`/3d/map`. The map runs as a standalone full-screen view — no sidebar,
no topbar, no global time picker — so the scene gets the whole viewport.
The SkyWalking mark sits at the bottom-left; the `×` at the top-right
returns you to the rest of Horizon.

## Tiers

A **tier** is a horizontal plane in the stack that groups related
SkyWalking layers by their role in the system. Tiers are the spine of
the map: they read top-to-bottom the way a request flows, from the
apps a user touches down to the platform everything runs on.

Horizon ships four bundled tiers:

| Tier | What lives here | Examples |
|---|---|---|
| **Apps** (top) | The application surfaces and their direct dependencies as the app sees them | General (agent) services, Browser/RUM, iOS, mini-programs, and the Virtual* targets (database / cache / MQ / gateway / GenAI) |
| **Middleware** | The data and messaging services, gateways, and self-observability | MySQL, PostgreSQL, Redis, MongoDB, Elasticsearch, Kafka, RocketMQ, RabbitMQ, Pulsar, APISIX, Nginx, Kong, Flink, the SkyWalking SO11Y components, and cloud-managed data services |
| **Service Mesh** | The mesh that fronts the apps | Istio managed services, Istio data plane (Envoy sidecars), Istio control plane, Cilium, Envoy AI Gateway |
| **Infra** (bottom) | The platform the rest runs on | Kubernetes cluster + service, Linux/Windows hosts, virtual machines, EKS |

Every layer OAP reports is placed onto exactly one tier. A layer that
Horizon hasn't classified yet (for example a brand-new OAP layer) lands
on the Middleware tier with an "unclassified" mark so an operator
notices it and can re-assign it.

The tier list on the right-hand panel mirrors this stack. Click a tier
row to fly the camera to it; use the eye toggle to show or hide every
layer in that tier at once. The row also shows how many of the tier's
services are currently visible.

## Reading the map

### Cubes

Each cube is one service. Cubes are grouped into their layer's zone on
the tier, and each zone is colored with the layer's brand color and
stamped with the project's logo (Istio's sail, the Kubernetes helm
wheel, a database cylinder, a queue, and so on) so you can identify a
zone at a glance from any camera angle.

Layers that ship a topology (General, Service Mesh, Kubernetes Service,
Cilium) lay their cubes out by call dependency — upstream callers on one
side, downstream services on the other — like the 2D service map. Layers
without a topology pack their cubes into a tidy grid.

### Traffic

A small pill under a cube shows that service's live traffic — requests
per minute for app and mesh services, queries or operations per second
for data services, and so on, each with its own unit. The number is the
service's headline throughput metric for the current window.

Traffic pills appear on cubes that are close enough to read; zoom out
far enough and they fade away to keep the scene clean, then return as
you zoom back in. A selected cube always shows its number.

### Alarms

When a service has an alarm in the last 20 minutes, a small **red
beacon** pulses on the top corner of its cube. The cube keeps its layer
color — the beacon is the alert signal, so you can still tell which
layer a troubled service belongs to. The alarm feed refreshes on its own
while the map is open.

### Connections

The map draws three kinds of lines:

- **In-layer calls** — light cyan tubes between two services in the same
  layer, with animated packets flowing along them. This is each layer's
  internal call graph.
- **Cross-layer calls** — soft orange arrows between services in
  different layers on the same tier (for example *Browser → Frontend*,
  or *Frontend → Virtual Database*). The arrow points from caller to
  callee.
- **Hierarchy links** — thicker gray tubes that connect the different
  views of the *same logical service* across tiers (for example a
  service seen by its agent, by the mesh, and as a Kubernetes service).
  These represent identity, not traffic, so they only appear when you
  select a cube, and show just that cube's relatives — then disappear
  when you deselect.

## Interacting

- **Camera** — drag to rotate, scroll to zoom, and the on-screen toolbar
  (top-left) gives the same gestures as buttons. Arrow keys or **WASD**
  pan the view; hold **Shift** for a bigger step.
- **Select a service** — click a cube. It highlights, a detail card
  appears beside it (service name, layer, and an **Open dashboard**
  button that jumps to that service's layer dashboard in a new tab), and
  its cross-tier hierarchy links light up. Click empty space, click
  another cube, or press **Esc** to deselect.
- **Hover** — hovering a cube shows a quick tooltip with the service's
  name and layer next to it.

## Loading timeline

Because a full deployment is too much to fetch in one request, the map
loads in stages, and a slim **timeline strip** at the bottom shows the
progress live:

1. **Services** — the service roster and which layers they belong to.
2. **Templates** — which layers carry a topology.
3. **Topologies** — each topology-bearing layer's call graph.
4. **Hierarchy** — the cross-tier identity links between the different
   views of the same service. Only services that are new since the last
   run are fetched; the rest are reused, so a steady deployment costs
   nothing here on refresh.
5. **Layout** — placing the cubes.
6. **Metrics** — the per-service traffic numbers, fetched in batches so
   the cubes light up progressively.

Each step shows its status as the map builds; click a step to open a
drawer with its detail (services added/removed since last run, per-layer
topology results, metric progress, and so on). A refresh button on the
strip re-runs the whole sequence.

## Configuration

What the map shows is driven by a single configuration that an
administrator edits in the UI at `/admin/3d-map` (linked under
**Dashboard setup** in the sidebar). It is a **structured editor** — you
work with tiers, layers, colors, and metrics through form controls, not
raw JSON. Horizon ships a bundled default so the map is useful out of the
box; your edits are kept as a local draft in your browser, and **Check
diff & push** publishes them to OAP — which is the copy the map then
renders (falling back to the bundled default if OAP has none).

From the editor you can:

- **Filter layers** — one global layer filter, written as a regex. A
  layer it excludes is dropped from the map entirely. This is the only
  filter; everything it admits is then placed on a tier.
- **Arrange tiers** — rename tiers, reorder them top-to-bottom, and pin
  each layer to a tier. A layer you don't pin lands on the **failover
  tier** you nominate, so nothing silently falls off the map.
- **Group layers** — cluster several related layers (for example the
  SkyWalking self-observability components) into one labelled block on a
  tier, while each member keeps its own cube color.
- **Color layers** — pick each layer's brand color (used for the cube,
  zone, and stamp).
- **Choose a traffic metric** — for each layer, set the single throughput
  metric its cubes display: the MQE expression, a display label, and a
  unit. The bundled defaults are seeded from each layer's dashboard
  template, so most layers show a sensible number out of the box.

A read-only **Service-map layers** list shows which layers lay their
cubes out as a call graph — that comes from each layer's template (its
service-map capability), not from this page.

Pushed changes take effect the next time the map is opened. A **Reset**
action reloads either the shipped bundled default or OAP's current
version, so you can start over before saving.

**Export** downloads the map's in-use configuration — the version live on
OAP, or the bundled default when OAP has none — as a JSON file, for backup,
sharing, or moving it to another OAP. **Import** reads a configuration JSON
file and loads it as a local draft; preview it, then **Check diff & push**
to publish. Import never writes OAP directly, and a file that isn't a valid
3D-map configuration is rejected with a message.

### Tuning the metric fan-out

The map's loading stages run in batches, several requests at once. How aggressively they do this is governed by the `performance.bulk.infra3d` block in [`horizon.yaml`](../setup/horizon-yaml.md#performance-tuning) — an operator setting, not part of the map configuration, so it is **not** in the structured editor and does **not** travel with an exported / imported map. Edit `horizon.yaml`; the change is hot-reloaded and takes effect the next time the map is opened:

- `metricConcurrency` — how many metric batches load at the same time. Default `4`, range `1`–`8`. Raise it to fill the cubes faster on a large deployment when OAP has headroom; lower it (toward `1`) if a busy OAP rejects or slows the burst of metric requests during the Metrics step.
- `metricBulkSize` — how many services share one metric request. Default `6`, range `1`–`12`. Larger means fewer requests, but OAP rejects an oversized request, so this is capped — leave it at the default unless you have a reason to change it.
- `topologyConcurrency` — how many layer call-graphs load at once during the Topologies step. Default `4`, range `1`–`16`.
- `templateConcurrency` — how many layer templates load at once during the Templates step. Default `8`, range `1`–`32`.

The defaults are tuned for a typical deployment; only revisit these if the loading timeline stalls on the Metrics, Topologies, or Templates step, or if OAP returns errors under the load.

Viewing the map needs read access (`infra-3d:read`, held by the built-in
viewer role and above); editing and publishing the configuration needs
`overview:write` (operators and admins by default). See
[Roles and Permissions](../access-control/rbac.md).
