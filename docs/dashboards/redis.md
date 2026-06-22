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
# Redis

The **REDIS** layer monitors Redis deployments scraped through OpenTelemetry's Redis receiver and forwarded to OAP as meters. It groups under **Databases** in the sidebar and is a metrics-only layer: each Redis cluster is a service, and the individual Redis processes under it are instances.

In Horizon's sidebar this layer's services are listed as **Redis clusters**, and the processes under a cluster as **Nodes**. The REDIS layer enables only the Service and Instance scopes — it has no endpoint dashboard, no topology or maps, and no Traces or Logs tabs.

This page is the **operator reference** for the bundled REDIS dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled REDIS template; if an operator has published a customized REDIS template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a cluster, the layer landing page lists every Redis cluster with four sortable columns, sorted by command throughput (**Commands/s**) by default:

- **Commands/s** — total commands per second across the cluster, summed over command types (`aggregate_labels(meter_redis_total_commands_rate,sum(cmd))`).

- **Hit Rate** — keyspace hit rate as a percentage, averaged across the cluster (`aggregate_labels(meter_redis_hit_rate,avg)`).

- **Memory %** — used memory as a percentage of max memory across the cluster (`latest(aggregate_labels(meter_redis_memory_used_bytes,sum)/aggregate_labels(meter_redis_memory_max_bytes,sum))*100`).

- **Clients** — connected clients across the cluster (`latest(aggregate_labels(meter_redis_connected_clients,sum))`).

## Service dashboard

The primary drill-down for one selected Redis cluster. All cluster-scope widgets aggregate over the nodes that make up the cluster.

**Status cards**

- **Uptime (days)** — cluster uptime in days, taken from the longest-running node (`latest(aggregate_labels(meter_redis_uptime,max))/3600/24`).

- **Connected Clients** — total connected clients across the cluster (`latest(aggregate_labels(meter_redis_connected_clients,sum))`).

- **Blocked Clients** — total clients blocked on a blocking call across the cluster (`latest(aggregate_labels(meter_redis_blocked_clients,sum))`).

- **Memory Usage** — used memory as a percentage of max memory across the cluster (`latest(aggregate_labels(meter_redis_memory_used_bytes,sum)/aggregate_labels(meter_redis_memory_max_bytes,sum))*100`).

**Charts**

- **Total Commands / s** — commands per second across the cluster, summed over command types (`aggregate_labels(meter_redis_total_commands_rate,sum(cmd))`).

- **Hit Rate** — keyspace hit rate as a percentage (`aggregate_labels(meter_redis_hit_rate,avg)`).

- **Avg Command Time / s** — mean per-command duration, total command duration divided by total command count, summed over command types (`aggregate_labels(meter_redis_commands_duration,sum(cmd))/aggregate_labels(meter_redis_commands_total,sum(cmd))`).

- **Net I/O (KB)** — network throughput in KB, split into **in** and **out** (`aggregate_labels(meter_redis_net_input_bytes_total,sum)/1024`, `aggregate_labels(meter_redis_net_output_bytes_total,sum)/1024`).

- **Keys** — keyspace size over time, split into **total** keys, **evicted** keys, and **expired** keys (`aggregate_labels(meter_redis_db_keys,sum)`, `aggregate_labels(meter_redis_evicted_keys_total,sum)`, `aggregate_labels(meter_redis_expired_keys_total,sum)`).

- **Slow Commands** — the top 10 slowest captured commands in ms, sampled by the SkyWalking agent at the call site (`top_n(top_n_database_statement,10,des)`). Each row carries the command text. Shows `no data` when OAP captured no slow commands in the window.

## Instance dashboard

For one selected node (a single Redis process under the cluster).

**Status cards**

- **Uptime (days)** — node uptime in days (`latest(meter_redis_instance_uptime)/3600/24`).

- **Connected Clients** — clients connected to this node (`latest(meter_redis_instance_connected_clients)`).

- **Blocked Clients** — clients blocked on a blocking call on this node (`latest(meter_redis_instance_redis_blocked_clients)`).

- **Memory Max (MB)** — configured max memory for this node in MB (`latest(meter_redis_instance_memory_max_bytes)/1000/1000`).

**Charts**

- **Memory Usage (%)** — used memory as a percentage of max for this node (`meter_redis_instance_memory_usage`).

- **Commands / s** — commands per second on this node (`meter_redis_instance_total_commands_rate`).

- **Hit Rate** — keyspace hit rate as a percentage for this node (`meter_redis_instance_hit_rate`).

- **Net I/O (KB)** — network throughput in KB for this node, split into **in** and **out** (`meter_redis_instance_net_input_bytes_total/1024`, `meter_redis_instance_net_output_bytes_total/1024`).

- **Keys** — keyspace size over time for this node, split into **total**, **evicted**, and **expired** keys (`meter_redis_instance_db_keys`, `meter_redis_instance_evicted_keys_total`, `meter_redis_instance_expired_keys_total`).

- **Total Command Time (s)** — total time spent on commands per second for this node (`meter_redis_instance_commands_duration_seconds_total_rate`).

- **Avg Command Time** — mean time spent per command on this node (`meter_redis_instance_average_time_spent_by_command`).

## Requirements

The REDIS dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs:

- **Cluster meters** — the `meter_redis_*` family (commands rate, hit rate, used / max memory, connected and blocked clients, uptime, network bytes, keyspace counts, command duration and count), aggregated by command label where the metric is per-command. These back the service list and the cluster dashboard.

- **Node meters** — the `meter_redis_instance_*` family (the same measures at single-process scope), which back the node dashboard.

- **Sampled records** — `top_n_database_statement` for the Slow Commands list, captured by the SkyWalking agent at the call site when slow-command sampling is enabled.

These meters come from the OpenTelemetry Redis receiver; see SkyWalking's Redis monitoring setup for how to wire the collector to OAP. Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a node-scope metric is empty until that level of data is reported.
