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
# Virtual Cache

The **VIRTUAL_CACHE** layer monitors the cache systems your services talk to — Redis, Memcached, and the like — as **virtual** targets. There is no agent inside the cache itself; the data is synthesized from the cache calls that instrumented services make, so each cache appears as a service whose traffic, latency, and success rate are reconstructed from the client side.

In Horizon's sidebar this layer is grouped under **Virtual targets** and named **Virtual Cache**. Its services are listed as **Caches**. The layer is single-scope: it ships only the **Service** (cache) dashboard — there are no instance, endpoint, topology, trace, or log tabs for virtual caches, so this page documents the Cache list and the Cache dashboard only.

This page is the **operator reference** for the bundled VIRTUAL_CACHE dashboard: what you see on the cache landing list and what each widget on the Cache dashboard means.

> The widgets and metrics below are read from the bundled VIRTUAL_CACHE template; if an operator has published a customized VIRTUAL_CACHE template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Cache list

Before opening a cache, the layer landing page lists every virtual cache with four sortable columns, sorted by access traffic (**Access RPM**) by default:

- **Access RPM** — total cache accesses per minute (`cache_access_cpm`).

- **Latency** — average access latency in ms (`cache_access_resp_time`).

- **p95** — 95th-percentile access latency in ms (`cache_access_percentile{p='95'}`).

- **Error Rate** — percent of failed accesses (`100 - cache_access_sla/100`).

## Cache dashboard

The drill-down for one selected cache. The dashboard splits into three views of the same traffic: the combined **access** (all operations), then **read** and **write** broken out separately, and finally the slowest captured commands.

**Access (all operations)**

- **Access Traffic** — total cache accesses per minute (`cache_access_cpm`).

- **Avg Access Latency** — mean access latency in ms (`cache_access_resp_time`).

- **Access Success Rate** — percent of successful accesses (`cache_access_sla/100`).

- **Access Latency Percentile** — p50 / p75 / p90 / p95 / p99 access latency, the tail of the access-latency distribution (`cache_access_percentile`).

**Read**

- **Read Traffic** — cache read operations per minute (`cache_read_cpm`).

- **Read Avg Latency** — mean read latency in ms (`cache_read_resp_time`).

- **Read Success Rate** — percent of successful reads (`cache_read_sla/100`).

- **Read Latency Percentile** — p50 / p75 / p90 / p95 / p99 read latency (`cache_read_percentile`).

**Write**

- **Write Traffic** — cache write operations per minute (`cache_write_cpm`).

- **Write Avg Latency** — mean write latency in ms (`cache_write_resp_time`).

- **Write Success Rate** — percent of successful writes (`cache_write_sla/100`).

- **Write Latency Percentile** — p50 / p75 / p90 / p95 / p99 write latency (`cache_write_percentile`).

**Slow commands**

- **Slow Read Commands** — the 10 slowest captured read commands against this cache (`top_n(top_n_cache_read_command, 10, des)`, ms). Each row is a single execution — click it to copy the command, or use the trace icon at the row head to open its originating trace (shown only when the sample carries one). Shows `no data` when OAP captured no slow read commands in the window.

- **Slow Write Commands** — the 10 slowest captured write commands against this cache (`top_n(top_n_cache_write_command, 10, des)`, ms). Same row behavior as Slow Read Commands — click to copy, or open the originating trace when the sample has one. Shows `no data` when none were captured.

## Requirements

The VIRTUAL_CACHE dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs:

- **Cache-access metrics** — the `cache_access_*` family (traffic, response time, SLA, percentiles), produced by OAP from the cache calls that instrumented services make.

- **Read / write metrics** — the `cache_read_*` and `cache_write_*` families, the same measures split by operation, for the Read and Write widgets.

- **Sampled records** — `top_n_cache_read_command` and `top_n_cache_write_command` for the Slow Read / Write Commands lists, captured by OAP when slow-command sampling is enabled.

Each metric is queried at the cache's Service scope; OAP does not roll a metric up across scopes, so a widget stays empty until that measure is reported for the cache. Virtual-cache data only appears when the services calling the cache are instrumented and OAP's virtual-cache analysis is enabled — see the [Virtual Cache setup guide](https://skywalking.apache.org/docs/main/next/en/setup/service-agent/virtual-cache/) for how OAP derives these targets.
