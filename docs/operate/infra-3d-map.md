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
| **Service Mesh** | The mesh that fronts the apps | Istio managed services, Istio data plane (Envoy sidecars), Istio control plane, Cilium, Envoy AI Gateway |
| **Middleware** | The data and messaging services, gateways, and self-observability | MySQL, PostgreSQL, Redis, MongoDB, Elasticsearch, Kafka, RocketMQ, RabbitMQ, Pulsar, APISIX, Nginx, Kong, Flink, the SkyWalking SO11Y components, and cloud-managed data services |
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
4. **Layout** — placing the cubes.
5. **Metrics** — the per-service traffic numbers, fetched in batches so
   the cubes light up progressively.

Each step shows its status as the map builds; click a step to open a
drawer with its detail (services added/removed since last run, per-layer
topology results, metric progress, and so on). A refresh button on the
strip re-runs the whole sequence.

## Configuration

The map is driven by a global configuration that an administrator edits
at `/admin/3d-map` (linked under **Dashboard setup** in the sidebar).
The editor is the same dark, dense surface as the rest of Horizon's
admin pages, with a structured form plus an advanced raw-JSON view.

From it you can:

- **Filter layers** — a global filter, plus a per-tier filter, to choose
  which layers appear on the map.
- **Arrange tiers** — rename tiers, reorder them top-to-bottom, and
  assign each layer to a tier.
- **Color layers** — pick each layer's brand color (used for the cube,
  zone, and stamp).
- **Choose traffic metrics** — pick the throughput metric and unit each
  layer's cubes display. Topology layers can carry both a server-side and
  client-side metric (the server side is preferred, with the client side
  as a fallback); other layers carry a single load metric. The bundled
  defaults are seeded from each layer's dashboard template, so most
  layers show a sensible number out of the box.
- **Style connections** — adjust the color and weight of the in-layer,
  cross-layer, and hierarchy lines.

Saving takes effect the next time the map is opened. A **Reset to
bundled** action restores the shipped defaults for review before saving.

The bundled configuration is the read-only baseline; saved changes
shadow it. Both the map and the editor are gated by access control — any
signed-in user with read access can view the map, while editing the
configuration requires the 3D-map write permission (granted to operators
and admins by default). See [Roles and Permissions](../access-control/rbac.md).
