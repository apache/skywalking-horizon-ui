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
# Overview Dashboards

**Overview dashboards** are the cross-layer war-room views — the "is everything OK?" pane an operator keeps on the wall. Unlike a per-layer dashboard, which drills into one selected service / instance / endpoint inside a single layer, an overview pulls a handful of layers onto one screen at once: a row of count + health tiles per layer, a live service map, the currently-firing alarms, and a Kubernetes capacity strip. It answers "how many services are up, how hard are they working, is anything on fire, and is the cluster running out of room" without you clicking into any one service.

Overviews are listed at the top of the sidebar, above the per-layer entries. Each overview only appears when at least one of the layers it draws from is actually reporting — so an empty environment shows a short list, and tiles light up as agents and receivers come online (on the same ~60-second cadence the menu refreshes). Within an overview, an individual layer's tile auto-hides the same way: a Services overview on a deployment with no message queues simply drops the Virtual MQs tile rather than showing it empty.

This page is the **operator reference** for the two bundled overviews — **Services Dashboard** and **Mesh Dashboard** — describing what each panel shows and which layers it folds in.

> The widgets and metrics below are read from the bundled overview templates; if an administrator has published a customized copy to OAP, the live page reflects that copy instead. These are editable defaults — you reshape them (add / remove / resize widgets, swap MQE) in the **Overview Templates** admin page on a bundled-default → local-draft → **Check diff & push** flow. See [Overview Templates](../customization/overview-templates.md) for the editor and the stored template format.

## How an overview is laid out

Every overview is built from the same small set of widget kinds on a 12-column grid:

- **Section break** — a row header that labels and groups the panels under it (e.g. "Services", "Topology & active alarms", "Kubernetes").
- **KPI tile** — a per-layer count + a few headline numbers (RPM, latency, SLA) for that layer. The count is how many services that layer is currently reporting; a tile with zero reporting services is hidden.
- **Topology** — a live service map for one layer, the same renderer as that layer's Topology tab but without the detail sidebar.
- **Alarms** — a read-only rail of the alarms firing right now for a layer's services. Horizon has no acknowledge / close / silence — alarm recovery is backend-automatic.
- **Metric composite** — a mixed grid of count tiles plus progress bars, used for capacity summaries (the Kubernetes block) and control-plane activity (Istio pilot).

For the full widget vocabulary and the grid model, see [Overview Templates](../customization/overview-templates.md) and [Overview Widgets](../components/overview-widgets.md).

## Services Dashboard

**Cross-layer service health.** This is the default landing overview: traced application services on the GENERAL layer, the virtual backends those services talk to (databases, caches, message queues, GenAI providers), and the Kubernetes capacity underneath them all — on one screen. It folds in the GENERAL, VIRTUAL_DATABASE, VIRTUAL_CACHE, VIRTUAL_MQ, VIRTUAL_GENAI, and K8S layers; any of those that isn't reporting drops its tile automatically.

### Services row

Five KPI tiles, one per service-class layer, each showing that layer's reporting service **count** plus three headline numbers:

- **General services** (GENERAL) — traced application services. **RPM** (total calls per minute, `service_cpm`), **Latency** (average response time in ms, `service_resp_time`), **SLA** (percent successful, `service_sla/100`).
- **Virtual databases** (VIRTUAL_DATABASE) — backend databases observed via client-side spans. **RPM** (`database_access_cpm`), **Latency** (`database_access_resp_time`), **SLA** (`database_access_sla/100`).
- **Virtual caches** (VIRTUAL_CACHE) — Redis / Memcached / … observed via client-side spans. **RPM** (`cache_access_cpm`), **Latency** (`cache_access_resp_time`), **SLA** (`cache_access_sla/100`).
- **Virtual MQs** (VIRTUAL_MQ) — message queues observed via consume + produce spans. **Consume** (consume rate per minute, `mq_service_consume_cpm`), **Produce** (produce rate per minute, `mq_service_produce_cpm`), **Consume latency** (ms, `mq_service_consume_latency`).
- **Virtual GenAI** (VIRTUAL_GENAI) — GenAI backends observed via instrumented client spans. **RPM** (`gen_ai_provider_cpm`), **Latency** (`gen_ai_provider_resp_time`), **SLA** (`gen_ai_provider_sla/100`).

The RPM / consume / produce numbers are summed across the layer; latency and SLA are averaged. A layer with nothing reporting (no GenAI backends in this deployment, say) simply leaves its tile off the row.

### Topology & active alarms

- **General service topology** — a live service map of the GENERAL layer, taking up most of the row. Same map you see on the per-layer Topology tab, embedded here for the war-room at-a-glance view.
- **Active alarms** — a rail down the right side listing the alarms currently firing on agent-reported (GENERAL) services, up to 12 at a time. Read-only.

### Kubernetes

- **Cluster capacity & utilisation** — a full-width composite summarizing the K8S layer. On the left, the cluster inventory as latest counts: **Nodes** (`k8s_cluster_node_total`), **Namespaces** (`k8s_cluster_namespace_total`), **Deployments** (`k8s_cluster_deployment_total`), **StatefulSets** (`k8s_cluster_statefulset_total`), **DaemonSets** (`k8s_cluster_daemonset_total`), **Services** (`k8s_cluster_service_total`), and **Containers** (`k8s_cluster_container_total`). On the right, three utilisation bars showing how much of the cluster is already committed — **CPU** (requested cores over capacity, `k8s_cluster_cpu_cores_requests/k8s_cluster_cpu_cores*100`), **Memory** (requested over total, `k8s_cluster_memory_requests/k8s_cluster_memory_total*100`), and **Storage** (allocated over total, `(k8s_cluster_storage_total-k8s_cluster_storage_allocatable)/k8s_cluster_storage_total*100`), each on a 0 – 100 % scale. This block is the "are we about to run out of room" check that the service tiles above can't tell you.

## Mesh Dashboard

**Istio data-plane health.** Where the Services dashboard centers on language-agent traffic, this overview centers on a service mesh: the services routed through the Istio data plane, the Istio control-plane (pilot / xDS) push activity that keeps them configured, and — because a mesh always runs on Kubernetes — the same cluster capacity strip folded in. It draws from the MESH, MESH_CP, and K8S layers.

### Mesh services row

- **Istio-managed services** (MESH) — a KPI tile with the mesh service **count** plus **RPM** (calls per minute, `service_cpm`), **P95** (95th-percentile latency in ms, `service_percentile{p='95'}`), and **SLA** (percent successful, `service_sla/100`). This is the data-plane equivalent of the General-services tile.
- **Istio pilot** (MESH_CP) — a composite summarizing control-plane activity: **xDS pushes** (config pushes Pilot sent, `meter_istio_pilot_xds_pushes`), **xDS connections** (proxies currently connected to Pilot, `meter_istio_pilot_xds`), **Services** (the layer's service count), and **Pilot errors** (rejected pushes + write timeouts across CDS / EDS / LDS / RDS, summed: `meter_istio_pilot_xds_cds_reject+meter_istio_pilot_xds_eds_reject+meter_istio_pilot_xds_lds_reject+meter_istio_pilot_xds_rds_reject+meter_istio_pilot_xds_write_timeout`). A climbing Pilot-errors number means the control plane is struggling to push valid config — a mesh-specific failure the data-plane tiles won't surface.

### Topology & active alarms

- **Mesh service topology** — a live service map of the MESH layer, the bulk of the row. Same renderer as the per-layer Topology tab.
- **Active alarms** — the right-hand rail of alarms currently firing on mesh-reported services, up to 12. Read-only.

### Kubernetes

- **Cluster capacity & utilisation** — the same full-width K8S composite as the Services dashboard: cluster inventory counts (Nodes, Namespaces, Deployments, StatefulSets, DaemonSets, Services, Containers) on the left, and CPU / Memory / Storage commitment bars on the right (same metrics and 0 – 100 % scale). Mesh deployments always ride on Kubernetes, so the capacity block lives directly under the mesh health.

## Requirements

An overview is a pure consumer of what OAP reports — it invents no data, and a tile or panel with no backing metric simply hides (the layer count drops to zero and the tile is omitted) or reads `no data`. To populate the two bundled overviews, OAP needs:

- **Service-scope metrics** for each service-class layer — the `service_*` family for GENERAL and MESH (traffic, response time, SLA, percentile), and the per-layer virtual-backend families `database_access_*`, `cache_access_*`, `mq_service_*`, and `gen_ai_provider_*` for the virtual layers. Each is queried at its own OAP scope; OAP does not roll a metric up across scopes.
- **Relation metrics** for the embedded service maps — `service_relation_*` at the GENERAL and MESH layers — produced by OAP from the traced / mesh-reported call topology.
- **Alarm data** — firing alarms scoped to the layer, for the Active-alarms rails.
- **Istio control-plane meters** — the `meter_istio_pilot_*` family on the MESH_CP layer, for the Istio pilot composite.
- **Kubernetes cluster metrics** — the `k8s_cluster_*` family (inventory totals plus CPU / memory / storage capacity), reported by the OAP Kubernetes monitoring on the K8S layer, for the capacity composite.

When a whole layer is missing — no virtual MQs, no mesh, no Kubernetes monitoring — its tile or block is hidden rather than shown empty, and the overview itself drops out of the sidebar once none of its layers are reporting.
