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
# Service Map & Topology

The per-layer **Topology** tab draws a layer's services as an interactive, directed call graph: who calls whom, how hard each call lane is running, and how healthy each service is. It is the per-layer companion to the deployment-wide [3D Infrastructure Map](infra-3d-map.md) — same call relationships, but flat, focused on one layer, and clickable down to the individual instance.

Around the service map sit three related views that share the same canvas and reading conventions: the **instance map** drill-down (instance-to-instance traffic across a service-pair), the **Deployment** tab (instance-to-instance traffic *inside* one service), and the **API dependency** tab (the same graph drawn at the endpoint level). All four are driven by each layer's dashboard template, so what they measure varies by layer — but how you read and narrow them is identical.

## Which tabs you see

These views are layer capabilities, not global pages — a layer shows only the tabs its template enables:

- **Topology** appears for any layer whose template declares a service map.

- **Deployment** appears only for layers that configure an intra-service instance graph (for example a clustered store whose nodes call each other).

- **Dependency** (API dependency) appears only for layers that configure endpoint-level dependencies.

A layer with none of these declared shows no topology tabs at all. The map always opens on the layer's own service map; the instance map is reached by drilling into an edge, not from the sidebar.

## Reading the service map

The graph flows left to right. Entry traffic (the synthetic **User** node, and other callers with no upstream service) anchors the left edge; each downstream hop sits one column to the right. Within a column, the busiest services are stacked toward the top so the heavy lanes line up across columns.

### Nodes

Each circle is one service. Three visual channels carry its numbers, and **all three come from the layer's template** — nothing is hardcoded, so the exact metric and unit differ per layer:

- **The number inside the circle** is the service's headline throughput (requests per minute for app-style layers, queries or operations per second for data layers, and so on), shown with its configured unit.

- **The colored ring** around the circle is the health band. It maps a health metric (SLA, success rate, Apdex, error rate, …) onto a green → yellow → orange → red ramp. The legend under the map names the metric, prints the four break points, and states the reading direction — `higher = better` for SLA / success-rate / Apdex style metrics, `lower = better` for error-rate style metrics.

- **A technology badge** floats above the circle, picked from the service's detected component (the database, cache, queue, gateway, or framework SkyWalking identified). A service whose component SkyWalking could not resolve shows a neutral badge.

Two node shapes are not real services: the **User** entry node, and **conjectured peers** — external or unresolved callees (an address like `localhost:-1` or `rcmd:80` that SkyWalking observed traffic to but has no agent on). Conjectured peers are drawn as a cloud-with-`?` and carry no metrics of their own; they exist on the map only to complete a call lane. Selecting one shows a `virtual` tag in its detail panel.

### Edges

A line is a call relationship. Its thickness tracks the call rate on that lane — heavier line, more traffic. The flow animation along the line shows direction (caller → callee). Edges are not colored by health; the ring on the nodes carries that signal.

Click a line to open its detail panel. Each line metric is shown twice — **Client** (as the caller measured it) and **Server** (as the callee measured it) — side by side, each with a sparkline over the window so you can see the trend, not just the latest number. A lane may report only one side: a call into a conjectured peer has no server-side numbers, a call out from the User node has no client-side numbers, and the panel labels those `client only` / `server only` rather than showing a blank.

### Node detail

Selecting a node opens a panel with its template metrics, its **Upstream** list (services it calls) and **Downstream** list (services calling it), and two jumps: **Open service** (its layer dashboard) and **API map →** (its endpoint dependency graph). The node and edge panels are independent — you can keep both open at once.

## Focusing and narrowing the map

By default the map seeds from **every service in the layer** — the full layer overview. That is the right starting point for a small layer and the wrong one for a large estate. Two controls narrow it:

- **Focus** — open the service picker (top-right of the Topology toolbar) and select one or more services. The map then redraws around just those services and their neighbors. The picker supports search and selecting a whole service group at once.

- **Depth** — once at least one service is focused, a depth control appears: **1 hop**, **2 hops**, or **3 hops**. Depth is how many call hops out from the focused service the map walks. Depth has no effect on the full-layer overview (it already includes everything), so the control is hidden until you focus a service.

Additional controls on the canvas:

- **Filter** (top-left) hides nodes by layer, or hides the **User** node, so a busy graph reading from several layers can be thinned to the layers you care about. The filter stores what is hidden, so a service that only appears after a depth or time change starts out visible. **Reset** clears it.

- **Zoom / Fit** (top-right) and drag-to-pan move the camera; double-click the canvas to fit the whole graph. Drag a node to reposition it; the layout holds your placement.

The map honors the topbar time picker — change the window and every node and edge metric re-reads for that range.

## Instance map (drill-down)

When a service-to-service edge is selected, the edge panel offers **Instance map →**. This opens the instance-to-instance graph for that one service pair: the caller's instances in the left column, the callee's instances in the right, and the instance-level call relationships between them. It is the view for answering "which *instance* is the slow one" once the service map has pointed at the lane.

The instance map keeps two service pickers at the top so you can swap either side to an adjacent service without returning to the service map, a **Service map** back link, and the same client | server line-metric panel as the edge detail. A picker is shown only when there is a real choice — if a side has a single counterpart, its name is simply printed.

## Deployment (intra-service topology)

The **Deployment** tab draws the instance-to-instance call graph *within a single service* — the nodes of a clustered service talking to each other (for example a distributed store's members). It shows the full container inventory for the service, grouped by cluster or by role, with per-node metrics; call relationships are drawn as edges where SkyWalking reports them. A container that exists but has no intra-service call in the window (an idle sidecar, say) still appears on the map as an inventory node rather than being hidden.

Grouping (by cluster, by node role / node type) comes from the layer template. When a layer reports no intra-service relations, the tab is a grouped inventory of the service's containers with their metrics — no edges — which is the expected, by-design state for those layers, not an error.

## API dependency (endpoint graph)

The **Dependency** tab is the service map drawn one level down, at the endpoint (API) level. Pick a service in the header, search its endpoints, and select one — the map then shows that endpoint's upstream and downstream endpoint dependencies as a directed graph, with the same node metrics, edge sparklines, and pan / zoom / focus conventions as the service map.

One difference is inherent to the data: endpoint-relation metrics are recorded by the callee only. Edges therefore carry server-side numbers, and an endpoint with no resolvable metric values in the window is dropped from the graph rather than drawn empty.

## Two safeguards to know

The maps protect you from two failure modes that would otherwise read as "the data".

### "Topology too large to render"

A graph that grows past **5,000 services** or **15,000 calls** cannot be drawn legibly and risks overwhelming the browser, so the map declines to draw a partial picture. Instead it shows a notice with the actual counts and the remedy:

> **Topology too large to render** — N services · M calls. Pick a specific service above, or lower the depth, to see a complete map.

This is almost always the full-layer overview of a large estate. **Focus** one or a few services, and/or **lower the depth**, and the map renders. (Inside the embedded overview-widget snapshot, the same notice points you to open the full Topology tab to narrow the scope.)

### Partial metrics

Node and edge metrics are fetched from OAP in batches. When some of those batches fail (an OAP hiccup, a backend limit), the map still draws the graph but flags that the gaps are *unknown*, not zero:

> Some metrics could not be loaded (X of Y batches failed) — blank values may be unavailable, not zero.

This matters operationally: a blank ring or an empty traffic number under this banner means "we could not read it this time", and you should re-run before concluding a service is idle or down. On the **API dependency** map the same banner is phrased for its data shape — some endpoints or links may be missing, because an endpoint whose metrics failed to load is dropped rather than drawn empty. **Refresh** to retry.

## Access

Viewing any of these maps — service map, instance map, deployment, API dependency — requires the `topology:read` permission, which the built-in viewer role and above hold. See [Roles and Permissions](../access-control/rbac.md).
