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
# Virtual MQ

The **VIRTUAL_MQ** layer monitors the message-queue systems your services publish to and consume from — Kafka, RocketMQ, RabbitMQ, Pulsar, and the like — as **virtual** targets. There is no agent inside the broker itself; the data is synthesized from the produce and consume calls that instrumented services make, so each message-queue cluster appears as a service whose throughput, latency, and success rate are reconstructed from the client side.

In Horizon's sidebar this layer is grouped under **Virtual targets** and named **Virtual MQ**. Its services are listed as **MQ clusters**, and its endpoints — the queues / topics a cluster carries — are listed as **Topics**. The layer enables two scopes: the **Service** (MQ cluster) dashboard and the **Endpoint** (Topic) dashboard. There are no instance, topology, trace, or log tabs for virtual MQ, so this page documents the cluster list, the MQ cluster dashboard, and the Topic dashboard only.

This page is the **operator reference** for the bundled VIRTUAL_MQ dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled VIRTUAL_MQ template; if an operator has published a customized VIRTUAL_MQ template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## MQ cluster list

Before opening a cluster, the layer landing page lists every MQ cluster with four sortable columns, sorted by consume throughput (**Consume RPM**) by default:

- **Consume RPM** — messages consumed per minute across the cluster (`mq_service_consume_cpm`).

- **Produce RPM** — messages produced per minute across the cluster (`mq_service_produce_cpm`).

- **Consume Latency** — average time between message production and consumption, in ms (`mq_service_consume_latency`).

- **Consume Error Rate** — percent of failed consume operations (`100 - mq_service_consume_sla/100`).

## MQ cluster dashboard

The drill-down for one selected MQ cluster. The dashboard pairs the produce and consume sides of the cluster's traffic — throughput, success rate, and the consume-latency profile.

- **Consume Traffic** — messages consumed per minute (`mq_service_consume_cpm`).

- **Produce Traffic** — messages produced per minute (`mq_service_produce_cpm`).

- **Consume Avg Latency** — average time between message production and consumption, in ms (`mq_service_consume_latency`).

- **Consume Success Rate** — percent of successful consume operations (`mq_service_consume_sla/100`).

- **Produce Success Rate** — percent of successful produce operations (`mq_service_produce_sla/100`).

- **Consume Latency Percentile** — p50 / p75 / p90 / p95 / p99 of consume latency, the tail of the consume-latency distribution (`mq_service_consume_percentile`).

## Topic dashboard

For one selected Topic — a queue / topic under the cluster, on the Endpoint scope. It mirrors the cluster widgets at the per-topic level.

- **Topic Consume Traffic** — messages consumed per minute on the topic (`mq_endpoint_consume_cpm`).

- **Topic Produce Traffic** — messages produced per minute on the topic (`mq_endpoint_produce_cpm`).

- **Topic Consume Avg Latency** — average consume latency for the topic, in ms (`mq_endpoint_consume_latency`).

- **Topic Consume Success Rate** — percent of successful consume operations on the topic (`mq_endpoint_consume_sla/100`).

- **Topic Produce Success Rate** — percent of successful produce operations on the topic (`mq_endpoint_produce_sla/100`).

- **Topic Consume Latency Percentile** — p50 / p75 / p90 / p95 / p99 of the topic's consume latency (`mq_endpoint_consume_percentile`).

## Requirements

The VIRTUAL_MQ dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs:

- **MQ cluster metrics** — the `mq_service_*` family (consume / produce throughput, consume latency, consume / produce SLA, consume percentiles), produced by OAP from the produce and consume calls that instrumented services make.

- **Topic metrics** — the `mq_endpoint_*` family, the same measures evaluated at the Endpoint (Topic) scope, for the Topic dashboard.

Each metric is queried at its own OAP scope — the `mq_service_*` family at the MQ cluster's Service scope and the `mq_endpoint_*` family at the Topic's Endpoint scope. OAP does not roll a metric up across scopes, so a Topic widget stays empty until that measure is reported at the Topic level, independent of the cluster-scope data. Virtual-MQ data only appears when the services producing to and consuming from the broker are instrumented and OAP's virtual-MQ analysis is enabled — see the [Virtual MQ setup guide](https://skywalking.apache.org/docs/main/next/en/setup/service-agent/virtual-mq/) for how OAP derives these targets.
