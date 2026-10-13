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
# OTLP Virtual MQ

The **OTLP_VIRTUAL_MQ** layer holds the brokers that OpenTelemetry-instrumented services call, reconstructed from the callers' spans. A broker appears here when a CLIENT or PRODUCER span of an **OpenTelemetry Service** names it, through `messaging.system` and the peer address or peer name the span carries; the broker itself reports nothing, so every figure describes it as its clients see it. The layer is kept apart from the agent path's Virtual MQ layer because its metrics come from a different engine under their own `otlp_*` names.

In Horizon's sidebar this layer is nested under the **OTLP Service** entry and is named **OTLP Virtual MQ**. Each broker is listed as one of the **Brokers**. It is a virtual-target layer with a single scope: only the **Service** scope is enabled; there is no instance or endpoint scope, no topology, and no traces or logs tabs. The broker does appear as a node on the OpenTelemetry Service layer's topology, where the edges into it carry the calls.

This page is the **operator reference** for the bundled OTLP Virtual MQ dashboard.

> The widgets and metrics below are read from the bundled OTLP_VIRTUAL_MQ template; if an operator has published a customized OTLP_VIRTUAL_MQ template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md).

## Service list

The landing page lists every broker with three sortable columns, sorted by **Access RPM** by default:

- **Access RPM** — messages per minute, counted from the callers' spans (`otlp_mq_access_cpm`).

- **Latency** — average duration of those spans in ms (`otlp_mq_access_resp_time`).

- **Error Rate** — percent of them whose status is ERROR (`100 - otlp_mq_access_sla/100`).

## Service dashboard

- **Access Traffic** — messages per minute (`otlp_mq_access_cpm`).

- **Avg Response Time** — mean latency of the callers' spans in ms (`otlp_mq_access_resp_time`).

- **Success Rate** — percent of the callers' spans that did not end in ERROR (`otlp_mq_access_sla/100`).


## Destinations

The broker node is one row of the layer; the queues and topics the services published to are its endpoints. The **Top 20 destinations** list ranks them by messages per minute (`otlp_mq_destination_cpm`), mean latency (`otlp_mq_destination_resp_time`) or lowest success rate (`otlp_mq_destination_sla`), all taken from the producer spans. A broker whose client library reports no address, as the JMS API gives its clients none, is named after its messaging system, `jms`, and still carries its destinations here.

## Requirements

The dashboard is a pure consumer of what OAP reports. To populate it, OAP needs the OTLP trace receiver with the `trace-analyzer` module's shipped rule file, and client spans that name the broker: `messaging.system` with `server.address` and `server.port`. A span that names the system but no address or peer produces no broker here. For the upstream setup see the [OpenTelemetry trace analysis documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/trace-analyzer/#layers).
