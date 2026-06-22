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
# RabbitMQ

The **RABBITMQ** layer monitors RabbitMQ message brokers. OAP collects the metrics from RabbitMQ's Prometheus / OpenMetrics endpoint, so each broker cluster and each broker node surfaces as a SkyWalking entity in this layer.

In Horizon's sidebar this layer is named **RabbitMQ**. Its services are listed as **RabbitMQ clusters** and its instances as **Nodes** — a service is one RabbitMQ cluster, and each instance is one broker node inside it. The layer enables two scopes only: the **Service** (cluster) dashboard and the **Instance** (node) dashboard. There is no endpoint scope, no topology / map, and no traces or logs tab for this layer.

This page is the **operator reference** for the bundled RABBITMQ dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled RABBITMQ template; if an operator has published a customized RABBITMQ template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a cluster, the layer landing page lists every RabbitMQ cluster with four sortable columns, sorted by **Queues** by default:

- **Queues** — total queues across the cluster (`aggregate_labels(meter_rabbitmq_queues,sum)`).
- **Channels** — total open channels across the cluster (`aggregate_labels(meter_rabbitmq_channels,sum)`).
- **Connections** — total open connections across the cluster (`aggregate_labels(meter_rabbitmq_connections,sum)`).
- **Unconfirmed** — publisher messages awaiting confirmation across the cluster (`aggregate_labels(meter_rabbitmq_messages_unconfirmed,sum)`).

## Service dashboard

The cluster-level view for one selected RabbitMQ cluster.

- **Memory Available Before Block (MB)** — headroom in MB before the broker hits its memory high-watermark and starts blocking publishers (`meter_rabbitmq_memory_available_before_publisher_blocked`).
- **Disk Available Before Block (GB)** — headroom in GB before the broker hits its disk free-space limit and starts blocking publishers (`meter_rabbitmq_disk_space_available_before_publisher_blocked`).
- **File Descriptors + Sockets** — available file descriptors (`fds`) and available TCP sockets (`sockets`), the two resource pools that gate how many connections the broker can still accept (`meter_rabbitmq_file_descriptors_available`, `meter_rabbitmq_tcp_socket_available`).
- **Ready Messages** — messages ready to be delivered to consumers (`meter_rabbitmq_message_ready_delivered_consumers`).
- **Pending Ack** — messages delivered to consumers but not yet acknowledged (`meter_rabbitmq_message_unacknowledged_delivered_consumers`).
- **Publish Pipeline** — the publish path across four series: `published`, `confirmed`, `routed`, and `unconfirmed` (`meter_rabbitmq_messages_published`, `meter_rabbitmq_messages_confirmed`, `meter_rabbitmq_messages_routed`, `meter_rabbitmq_messages_unconfirmed`). A growing gap between published and confirmed/routed flags a routing or confirmation problem.
- **Unroutable Messages** — messages with no matching binding, split into `dropped` and `returned` (`meter_rabbitmq_messages_unroutable_dropped`, `meter_rabbitmq_messages_unroutable_returned`).
- **Queues** — queue lifecycle across the cluster: `total` currently present, plus the `declared`, `created`, and `deleted` running totals (`meter_rabbitmq_queues`, `meter_rabbitmq_queues_declared_total`, `meter_rabbitmq_queues_created_total`, `meter_rabbitmq_queues_deleted_total`).
- **Channels** — channel lifecycle: `total` currently open, plus the `opened` and `closed` running totals (`meter_rabbitmq_channels`, `meter_rabbitmq_channels_opened_total`, `meter_rabbitmq_channels_closed_total`).
- **Connections** — connection lifecycle: `total` currently open, plus the `opened` and `closed` running totals (`meter_rabbitmq_connections`, `meter_rabbitmq_connections_opened_total`, `meter_rabbitmq_connections_closed_total`).

## Instance dashboard

The node-level view for one selected broker node. The cards across the top are single-value (latest) readings; the remaining widgets are time-series.

- **Ready Messages** — messages ready for delivery on this node, latest value (`latest(meter_rabbitmq_node_queue_messages_ready)`).
- **Incoming Messages** — incoming message rate on this node, latest value (`latest(meter_rabbitmq_node_incoming_messages)`).
- **Outgoing Messages** — outgoing message total on this node, latest value (`latest(meter_rabbitmq_node_outgoing_messages_total)`).
- **Unacknowledged Messages** — delivered-but-unacknowledged messages on this node, latest value (`latest(meter_rabbitmq_node_unacknowledged_messages)`).
- **Connections / Publishers / Consumers** — the node's `connections`, `publishers`, and `consumers` counts (`latest(meter_rabbitmq_node_connections_total)`, `latest(meter_rabbitmq_node_publisher_total)`, `latest(meter_rabbitmq_node_consumer_total)`).
- **Channels + Queues** — the node's `channels` and `queues` counts (`latest(meter_rabbitmq_node_channel_total)`, `latest(meter_rabbitmq_node_queue_total)`).
- **Allocated Used %** — percentage of the node's allocated memory that is in use, latest value (`latest(meter_rabbitmq_node_allocated_used_percent)`).
- **Memory (MB)** — the node's memory breakdown in MB: `used`, `unused`, `resident`, and `total` allocated (`meter_rabbitmq_node_allocated_used_bytes`, `meter_rabbitmq_node_allocated_unused_bytes`, `meter_rabbitmq_node_process_resident_memory_bytes`, `meter_rabbitmq_node_allocated_total_bytes`).
- **Allocated By Type (MB)** — allocated memory broken down by allocator type in MB, one series per type (`meter_rabbitmq_node_allocated_by_type`).
- **Multi/Single-block Memory (MB)** — allocator block usage in MB across `multi used`, `multi unused`, `single used`, and `single unused` (`meter_rabbitmq_node_allocated_multiblock_used`, `meter_rabbitmq_node_allocated_multiblock_unused`, `meter_rabbitmq_node_allocated_singleblock_used`, `meter_rabbitmq_node_allocated_singleblock_unused`).

## Requirements

The RABBITMQ dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs:

- **Cluster (service-scope) metrics** — the `meter_rabbitmq_*` family (memory and disk headroom, file descriptors and sockets, ready / pending / unroutable messages, the publish pipeline, and queue / channel / connection lifecycle counters) that drives the service list and Service dashboard.
- **Node (instance-scope) metrics** — the `meter_rabbitmq_node_*` family (message counters, connections / publishers / consumers, channels / queues, and the allocator memory breakdown) that drives the Instance dashboard.

These metrics come from OAP's RabbitMQ monitoring, which scrapes the broker's Prometheus / OpenMetrics endpoint. See the [RabbitMQ monitoring setup](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-rabbitmq-monitoring/) in the SkyWalking backend documentation for how to enable it. Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so the node-scope widgets stay empty until per-node data is reported.
