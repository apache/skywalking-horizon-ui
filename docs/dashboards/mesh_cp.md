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
# Istio Control Plane

The **MESH_CP** layer monitors the Istio control plane — the `istiod` / Pilot process that distributes configuration to the data-plane proxies. SkyWalking scrapes the control-plane's Prometheus metrics over OpenTelemetry and rolls them into per-control-plane meters, so operators can watch xDS push health, proxy convergence, configuration validation, and the Go runtime of `istiod` itself. See the upstream [Istio monitoring setup](https://skywalking.apache.org/docs/main/next/en/setup/istio/readme/) for how to wire the telemetry pipeline.

In Horizon's sidebar this layer is named **Istio Control Plane** (grouped under **Istio**). Its services are listed as **Control Planes** — each control plane is named `service.namespace`, with the namespace shown as its grouping alias. The MESH_CP layer enables only the Service sub-tab; it has no instance, endpoint, topology, traces, or logs view.

This page is the **operator reference** for the bundled MESH_CP dashboard: what you see on the service scope and what each widget means.

> The widgets and metrics below are read from the bundled MESH_CP template; if an operator has published a customized MESH_CP template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a control plane, the layer landing page lists every Istio control plane with four sortable columns, sorted by **CPU** by default:

- **CPU** — average CPU usage of the control-plane process (`meter_istio_cpu`).

- **Goroutines** — total goroutines running in `istiod` (`meter_istio_go_goroutines`).

- **Pilot xDS** — total xDS connections Pilot is serving (`meter_istio_pilot_xds`).

- **Services** — total services Pilot knows about (`meter_istio_pilot_services`).

## Service dashboard

The primary drill-down for one selected control plane, covering its Go runtime, xDS push pipeline, configuration validation, and proxy conflicts.

- **CPU** — CPU usage of the control-plane process over time (`meter_istio_cpu`).

- **Goroutines** — goroutines running in `istiod` (`meter_istio_go_goroutines`).

- **Istio Versions** — the reported Pilot / Istio version build info, so a version roll-out is visible on the timeline (`meter_istio_pilot_version`).

- **Memory (MB)** — the Go runtime's memory footprint on one chart, in MB: allocated, heap in-use, stack in-use, virtual, and resident (`meter_istio_go_alloc`, `meter_istio_go_heap_inuse`, `meter_istio_go_stack_inuse`, `meter_istio_virtual_memory`, `meter_istio_resident_memory`, each `/1024/1024`).

- **Pilot Errors** — xDS rejections and push timeouts that indicate the control plane could not deliver config: CDS / EDS / RDS / LDS rejects plus write timeouts (`meter_istio_pilot_xds_cds_reject`, `meter_istio_pilot_xds_eds_reject`, `meter_istio_pilot_xds_rds_reject`, `meter_istio_pilot_xds_lds_reject`, `meter_istio_pilot_xds_write_timeout`).

- **Proxy Push Time (percentile)** — how long it takes to push config to proxies, as a latency percentile distribution in ms (`meter_istio_pilot_proxy_push_percentile`).

- **Pilot Pushes** — the rate of xDS pushes Pilot sends to proxies (`meter_istio_pilot_xds_pushes`).

- **Sidecar Injection Success** — successful sidecar-injection webhook calls (`meter_istio_sidecar_injection_success_total`).

- **ADS Monitoring** — the aggregated discovery surface on one chart: xDS connections, known services, and virtual services (`meter_istio_pilot_xds`, `meter_istio_pilot_services`, `meter_istio_pilot_virt_services`).

- **Configuration Validation** — Galley configuration-validation outcomes, passed vs failed (`meter_istio_galley_validation_passed`, `meter_istio_galley_validation_failed`).

- **Pilot Conflicts** — listener conflicts Pilot detected while generating config, broken out by type: outbound TCP/TCP, inbound, outbound TCP/HTTP, and outbound HTTP/TCP (`meter_istio_pilot_conflict_ol_tcp_tcp`, `meter_istio_pilot_conflict_il`, `meter_istio_pilot_conflict_ol_tcp_http`, `meter_istio_pilot_conflict_ol_http_tcp`).

## Requirements

The MESH_CP dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs the Istio control-plane meter family, produced from `istiod`'s Prometheus metrics collected over OpenTelemetry:

- **Control-plane metrics** — the `meter_istio_*` family for the service list and the service dashboard: the Go runtime (`meter_istio_cpu`, `meter_istio_go_goroutines`, the `meter_istio_go_*` memory gauges, `meter_istio_virtual_memory`, `meter_istio_resident_memory`), the Pilot / xDS pipeline (`meter_istio_pilot_xds`, `meter_istio_pilot_xds_pushes`, the `meter_istio_pilot_xds_*_reject` rejection counters, `meter_istio_pilot_xds_write_timeout`, `meter_istio_pilot_proxy_push_percentile`, `meter_istio_pilot_services`, `meter_istio_pilot_virt_services`, `meter_istio_pilot_version`, the `meter_istio_pilot_conflict_*` counters), sidecar injection (`meter_istio_sidecar_injection_success_total`), and Galley validation (`meter_istio_galley_validation_passed`, `meter_istio_galley_validation_failed`).

All MESH_CP metrics are reported at the control-plane Service scope; OAP does not roll a metric up across scopes, so the dashboard stays empty until the control plane's telemetry is reported. See the upstream [Istio monitoring setup](https://skywalking.apache.org/docs/main/next/en/setup/istio/readme/) for the collection pipeline that produces this family.
