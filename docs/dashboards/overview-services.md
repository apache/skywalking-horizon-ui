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
# Services Dashboard

The **Services Dashboard** is Horizon's default cross-layer overview — the "is everything OK?" war-room pane for your traced application services. It pulls several layers onto one screen at once: a row of count + health tiles for application and virtual-backend services, a live service map, the alarms firing right now, and the Kubernetes capacity underneath them all. It answers "how many services are up, how hard are they working, is anything on fire, and is the cluster running out of room" without you clicking into any one service.

It folds in the GENERAL, VIRTUAL_DATABASE, VIRTUAL_CACHE, VIRTUAL_MQ, VIRTUAL_GENAI, and K8S layers; any of those that isn't reporting drops its tile automatically. Overviews are listed at the top of the sidebar, above the per-layer entries, and each appears only while at least one of its layers is reporting (refreshed on the same ~60-second cadence as the menu). For the service-mesh counterpart, see the [Mesh Dashboard](overview-mesh.md).

> The widgets and metrics below are read from the bundled overview template; if an administrator has published a customized copy to OAP, the live page reflects that copy instead. These are editable defaults — reshape them (add / remove / resize widgets, swap MQE) in the **Overview Templates** admin page on a bundled-default → local-draft → **Check diff & push** flow. See [Overview Templates](../customization/overview-templates.md) for the editor and the stored format, and [Overview Widgets](../components/overview-widgets.md) for the widget vocabulary.

## Services row

Five KPI tiles, one per service-class layer, each showing that layer's reporting service **count** plus three headline numbers:

- **General services** (GENERAL) — traced application services. **RPM** (total calls per minute, `service_cpm`), **Latency** (average response time in ms, `service_resp_time`), **SLA** (percent successful, `service_sla/100`).
- **Virtual databases** (VIRTUAL_DATABASE) — backend databases observed via client-side spans. **RPM** (`database_access_cpm`), **Latency** (`database_access_resp_time`), **SLA** (`database_access_sla/100`).
- **Virtual caches** (VIRTUAL_CACHE) — Redis / Memcached / … observed via client-side spans. **RPM** (`cache_access_cpm`), **Latency** (`cache_access_resp_time`), **SLA** (`cache_access_sla/100`).
- **Virtual MQs** (VIRTUAL_MQ) — message queues observed via consume + produce spans. **Consume** (consume rate per minute, `mq_service_consume_cpm`), **Produce** (produce rate per minute, `mq_service_produce_cpm`), **Consume latency** (ms, `mq_service_consume_latency`).
- **Virtual GenAI** (VIRTUAL_GENAI) — GenAI backends observed via instrumented client spans. **RPM** (`gen_ai_provider_cpm`), **Latency** (`gen_ai_provider_resp_time`), **SLA** (`gen_ai_provider_sla/100`).

The RPM / consume / produce numbers are summed across the layer; latency and SLA are averaged. A layer with nothing reporting (no GenAI backends in this deployment, say) simply leaves its tile off the row.

## Topology & active alarms

- **General service topology** — a live service map of the GENERAL layer, taking up most of the row. Same map you see on the per-layer Topology tab, embedded here for the war-room at-a-glance view.
- **Active alarms** — a rail down the right side listing the alarms currently firing on agent-reported (GENERAL) services, up to 12 at a time. Read-only — alarm recovery is backend-automatic.

## Kubernetes

- **Cluster capacity & utilisation** — a full-width composite summarizing the K8S layer. On the left, the cluster inventory as latest counts: **Nodes** (`k8s_cluster_node_total`), **Namespaces** (`k8s_cluster_namespace_total`), **Deployments** (`k8s_cluster_deployment_total`), **StatefulSets** (`k8s_cluster_statefulset_total`), **DaemonSets** (`k8s_cluster_daemonset_total`), **Services** (`k8s_cluster_service_total`), and **Containers** (`k8s_cluster_container_total`). On the right, three utilisation bars showing how much of the cluster is already committed — **CPU** (requested cores over capacity, `k8s_cluster_cpu_cores_requests/k8s_cluster_cpu_cores*100`), **Memory** (requested over total, `k8s_cluster_memory_requests/k8s_cluster_memory_total*100`), and **Storage** (allocated over total, `(k8s_cluster_storage_total-k8s_cluster_storage_allocatable)/k8s_cluster_storage_total*100`), each on a 0 – 100 % scale. This block is the "are we about to run out of room" check that the service tiles above can't tell you.

## Requirements

An overview is a pure consumer of what OAP reports — it invents no data, and a tile or panel with no backing metric simply hides (the layer count drops to zero and the tile is omitted) or reads `no data`. To populate the Services Dashboard, OAP needs:

- **Service-scope metrics** for each service-class layer — the `service_*` family for GENERAL (traffic, response time, SLA), and the virtual-backend families `database_access_*`, `cache_access_*`, `mq_service_*`, and `gen_ai_provider_*` for the virtual layers. Each is queried at its own OAP scope; OAP does not roll a metric up across scopes.
- **Relation metrics** for the embedded service map — `service_relation_*` at the GENERAL layer.
- **Alarm data** — firing alarms scoped to the layer, for the Active-alarms rail.
- **Kubernetes cluster metrics** — the `k8s_cluster_*` family (inventory totals plus CPU / memory / storage capacity), reported by the OAP Kubernetes monitoring on the K8S layer, for the capacity composite.

When a whole layer is missing — no virtual MQs, no Kubernetes monitoring — its tile or block is hidden rather than shown empty, and the overview itself drops out of the sidebar once none of its layers are reporting.
