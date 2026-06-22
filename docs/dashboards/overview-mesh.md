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
# Mesh Dashboard

The **Mesh Dashboard** is the cross-layer overview for an Istio service mesh. Where the [Services Dashboard](overview-services.md) centers on language-agent traffic, this one centers on the data plane: it pulls onto one screen the services routed through the Istio data plane, the Istio control-plane (pilot / xDS) push activity that keeps them configured, and — because a mesh always runs on Kubernetes — the same cluster capacity strip. It draws from the MESH, MESH_CP, and K8S layers.

Like every overview, it sits at the top of the sidebar above the per-layer entries and appears only while at least one of its layers is reporting; a layer's tile auto-hides when that layer has nothing reporting (refreshed on the same ~60-second cadence as the menu).

> The widgets and metrics below are read from the bundled overview template; if an administrator has published a customized copy to OAP, the live page reflects that copy instead. These are editable defaults — reshape them in the **Overview Templates** admin page on a bundled-default → local-draft → **Check diff & push** flow. See [Overview Templates](../customization/overview-templates.md) for the editor and the stored format, and [Overview Widgets](../components/overview-widgets.md) for the widget vocabulary.

## Mesh services row

- **Istio-managed services** (MESH) — a KPI tile with the mesh service **count** plus **RPM** (calls per minute, `service_cpm`), **P95** (95th-percentile latency in ms, `service_percentile{p='95'}`), and **SLA** (percent successful, `service_sla/100`). This is the data-plane equivalent of the General-services tile.
- **Istio pilot** (MESH_CP) — a composite summarizing control-plane activity: **xDS pushes** (config pushes Pilot sent, `meter_istio_pilot_xds_pushes`), **xDS connections** (proxies currently connected to Pilot, `meter_istio_pilot_xds`), **Services** (the layer's service count), and **Pilot errors** (rejected pushes + write timeouts across CDS / EDS / LDS / RDS, summed: `meter_istio_pilot_xds_cds_reject+meter_istio_pilot_xds_eds_reject+meter_istio_pilot_xds_lds_reject+meter_istio_pilot_xds_rds_reject+meter_istio_pilot_xds_write_timeout`). A climbing Pilot-errors number means the control plane is struggling to push valid config — a mesh-specific failure the data-plane tiles won't surface.

## Topology & active alarms

- **Mesh service topology** — a live service map of the MESH layer, the bulk of the row. Same renderer as the per-layer Topology tab.
- **Active alarms** — the right-hand rail of alarms currently firing on mesh-reported services, up to 12. Read-only — alarm recovery is backend-automatic.

## Kubernetes

- **Cluster capacity & utilisation** — the same full-width K8S composite as the [Services Dashboard](overview-services.md): cluster inventory counts (Nodes, Namespaces, Deployments, StatefulSets, DaemonSets, Services, Containers) on the left, and CPU / Memory / Storage commitment bars on the right (same `k8s_cluster_*` metrics and 0 – 100 % scale). Mesh deployments always ride on Kubernetes, so the capacity block lives directly under the mesh health.

## Requirements

An overview is a pure consumer of what OAP reports — it invents no data, and a tile or panel with no backing metric simply hides or reads `no data`. To populate the Mesh Dashboard, OAP needs:

- **Service-scope metrics** on the MESH layer — the `service_*` family (traffic, response time, percentile, SLA), produced by OAP from the mesh-reported telemetry. Queried at its own OAP scope; OAP does not roll a metric up across scopes.
- **Istio control-plane meters** — the `meter_istio_pilot_*` family on the MESH_CP layer, for the Istio pilot composite.
- **Relation metrics** for the embedded service map — `service_relation_*` at the MESH layer.
- **Alarm data** — firing alarms scoped to the MESH layer, for the Active-alarms rail.
- **Kubernetes cluster metrics** — the `k8s_cluster_*` family on the K8S layer, for the capacity composite.

When a whole layer is missing — no mesh, no Kubernetes monitoring — its tile or block is hidden rather than shown empty, and the overview drops out of the sidebar once none of its layers are reporting.
