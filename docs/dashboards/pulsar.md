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
# Pulsar

The **PULSAR** layer monitors Apache Pulsar message brokers. SkyWalking collects Pulsar's broker metrics through OpenTelemetry and renders each Pulsar cluster as a service, with its brokers as instances — so a cluster's topic, subscription, and message-flow health sits beside the broker-level connection and JVM detail in one place.

In Horizon's sidebar this layer is named **Pulsar**, grouped under **MQ**. Its services are listed as **Pulsar clusters** and its instances as **Brokers**. The PULSAR layer enables the **Service** and **Instance** sub-tabs only — there is no endpoint scope, no topology, and no traces or logs tab for this layer.

This page is the **operator reference** for the bundled PULSAR dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled PULSAR template; if an operator has published a customized PULSAR template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Pulsar cluster list

Before opening a cluster, the layer landing page lists every Pulsar cluster with four sortable columns, sorted by **Topics** by default. Each column sums the per-label series across the cluster:

- **Topics** — total topics on the cluster (`meter_pulsar_total_topics`).

- **Subscriptions** — total subscriptions on the cluster (`meter_pulsar_total_subscriptions`).

- **Msg In** — incoming message rate (`meter_pulsar_message_rate_in`).

- **Msg Out** — outgoing message rate (`meter_pulsar_message_rate_out`).

## Service dashboard

The primary drill-down for one selected Pulsar cluster. Every widget aggregates the cluster's per-label series with `aggregate_labels(..., sum)`, giving cluster-wide totals.

- **Total Topics** — number of topics on the cluster (`meter_pulsar_total_topics`).

- **Subscriptions** — number of subscriptions on the cluster (`meter_pulsar_total_subscriptions`).

- **Producers** — number of connected producers (`meter_pulsar_total_producers`).

- **Consumers** — number of connected consumers (`meter_pulsar_total_consumers`).

- **Message Rate** — incoming vs outgoing message rate on one chart, plotted as `in` (`meter_pulsar_message_rate_in`) and `out` (`meter_pulsar_message_rate_out`).

- **Throughput** — incoming vs outgoing byte throughput on one chart, plotted as `in` (`meter_pulsar_throughput_in`) and `out` (`meter_pulsar_throughput_out`).

- **Storage Read/Write Rate** — bookkeeper storage read vs write rate, plotted as `read` (`meter_pulsar_storage_read_rate`) and `write` (`meter_pulsar_storage_write_rate`).

- **Storage Size (MB)** — physical vs logical storage size in MB, plotted as `physical` (`meter_pulsar_storage_size`) and `logical` (`meter_pulsar_storage_logical_size`); both are reported in bytes and divided by 1024 / 1024 for display.

## Instance dashboard

For one selected broker. These widgets read the broker-scope `meter_pulsar_broker_*` family directly.

- **Active Connections** — connections currently open on the broker (`meter_pulsar_broker_active_connections`).

- **Total Connections** — connections handled by the broker (`meter_pulsar_broker_total_connections`).

- **Conn Create Fail** — failed connection-create attempts (`meter_pulsar_broker_connection_create_fail_count`).

- **Conn Create Success** — successful connection-create attempts (`meter_pulsar_broker_connection_create_success_count`).

- **Connection Closed** — total connections closed (`meter_pulsar_broker_connection_closed_total_count`).

- **JVM Buffer Pool (MB)** — JVM buffer-pool bytes used by the broker, in MB (`meter_pulsar_broker_jvm_buffer_pool_used_bytes`, divided by 1024 / 1024).

- **JVM Memory Pool Used (MB)** — JVM memory-pool bytes used, in MB (`meter_pulsar_broker_jvm_memory_pool_used`, divided by 1024 / 1024).

- **JVM Memory (MB)** — JVM memory in MB plotted as `used`, `committed`, and `init` (`meter_pulsar_broker_jvm_memory_used`, `meter_pulsar_broker_jvm_memory_committed`, `meter_pulsar_broker_jvm_memory_init`, each divided by 1024 / 1024).

- **JVM Threads** — thread counts plotted as `current`, `daemon`, `peak`, and `deadlocked` (`meter_pulsar_broker_jvm_threads_current`, `meter_pulsar_broker_jvm_threads_daemon`, `meter_pulsar_broker_jvm_threads_peak`, `meter_pulsar_broker_jvm_threads_deadlocked`).

- **GC** — garbage-collection time vs count on a dual axis, with cumulative `seconds` on the left axis (`meter_pulsar_broker_jvm_gc_collection_seconds_sum`) and `count` on the right axis (`meter_pulsar_broker_jvm_gc_collection_seconds_count`).

## Requirements

The PULSAR dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs Pulsar monitoring enabled, so that the broker's OpenTelemetry metrics reach OAP and are aggregated into the Pulsar meter families:

- **Cluster (service) metrics** — the `meter_pulsar_*` family (topics, subscriptions, producers, consumers, message rate, throughput, and bookkeeper storage), which back the cluster list and the Service dashboard.

- **Broker (instance) metrics** — the `meter_pulsar_broker_*` family (connections and the broker JVM buffer / memory / thread / GC detail), which back the Instance dashboard.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a broker-scope metric is empty until that broker reports it. See [Pulsar monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-pulsar-monitoring/) for how to wire a Pulsar deployment into OAP.
