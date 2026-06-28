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
# Satellite (Self-Observability)

The **SO11Y_SATELLITE** layer is SkyWalking's self-observability view of [Apache SkyWalking Satellite](https://skywalking.apache.org/docs/skywalking-satellite/next/readme/) — the lightweight telemetry collector that sits in front of OAP, buffering and forwarding agent traffic. When a Satellite instance reports its own runtime metrics to OAP (via the OpenTelemetry receiver), each collector shows up here as a service so you can watch the collection tier the same way you watch instrumented applications.

In Horizon's sidebar this layer is named **Satellite**, and it is grouped under **Self-Observability** alongside the other components SkyWalking monitors about itself. Its services are listed as **Satellite services**. This layer is intentionally focused: it enables only the **Service** scope — there are no instance, endpoint, topology, traces, or logs sub-tabs. Everything Satellite exposes is read at the service level.

This page is the **operator reference** for the bundled Satellite dashboard: what you see on the service scope and what each widget means.

> The widgets and metrics below are read from the bundled SO11Y_SATELLITE template; if an operator has published a customized Satellite template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

The layer landing page lists every Satellite service that has reported. This layer defines no custom landing-page metric columns, so services are listed by name only — pick one to open its dashboard.

## Service dashboard

The dashboard for one selected Satellite collector. Every widget is a time-series line over the selected window, covering the collector's connection load, host CPU, internal queue, and the four stages of its event pipeline. The queue and event widgets break their series out **per Satellite pipeline** (`tracingpipe`, `jvmpipe`, `logpipe`, `meterpipe`, …), so you can see which collection pipeline is driving the rate; Connection Count and CPU are single series.

- **Connection Count** — the number of gRPC connections the collector currently holds, i.e. how many upstream agents and downstream OAP links are attached (`satellite_service_grpc_connect_count`).

- **CPU (%)** — host CPU utilization of the process running the Satellite gRPC server, as a percentage (`satellite_service_server_cpu_utilization`).

- **Queue Used** — how much of the internal buffering queue is currently occupied. Watch this against the collector's queue capacity — a queue that stays near full means Satellite is backing up and is at risk of dropping events (`satellite_service_queue_used_count`).

- **Receive Events** — events received from upstream agents per minute, the inbound rate into the collector (`satellite_service_receive_event_count`).

- **Fetch Events** — events fetched into the pipeline per minute, the rate at which buffered data is pulled forward for processing (`satellite_service_fetch_event_count`).

- **Queue Input / Output** — two series on one chart that show whether the queue is keeping pace: **input** is events written into the queue per minute (`satellite_service_queue_input_count`) and **output** is events sent on to OAP per minute (`satellite_service_send_event_count`). When output tracks input the collector is draining as fast as it fills; a persistent gap is the same backlog signal as a full **Queue Used**.

## Requirements

The Satellite dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs each Satellite instance to push its self-observability metrics to OAP's OpenTelemetry receiver, where they are aggregated into the `satellite_service_*` family at Service scope:

- **Connection and host metrics** — `satellite_service_grpc_connect_count` (gRPC connections) and `satellite_service_server_cpu_utilization` (server-process CPU).

- **Queue metrics** — `satellite_service_queue_used_count` for current queue occupancy, plus `satellite_service_queue_input_count` for the inbound queue rate.

- **Event-pipeline metrics** — `satellite_service_receive_event_count`, `satellite_service_fetch_event_count`, and `satellite_service_send_event_count` for the receive → fetch → send stages of the collection pipeline.

Each metric is queried at its own OAP scope; this layer reports only at Service scope, so the dashboard stays empty until a Satellite instance is configured to export its runtime metrics and they reach OAP. For how to wire that export and the underlying metric rules, see the SkyWalking [Satellite self-observability setup](https://skywalking.apache.org/docs/skywalking-satellite/next/readme/) documentation.
