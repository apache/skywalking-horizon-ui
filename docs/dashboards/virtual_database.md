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
# Virtual Database

The **VIRTUAL_DATABASE** layer is the conjugate view of database traffic: instead of monitoring the database server itself, it shows each database as a peer that your instrumented services talk to. SkyWalking's language agents detect outbound database calls in their traces and synthesize a virtual database node from the connection's peer address — so a database appears here whether or not it is independently monitored, reconstructed entirely from the caller's perspective.

In Horizon's sidebar this layer lives under the **Virtual targets** group and is named **Virtual Database**. Each synthesized database is listed as a **Database**. This is a virtual-target layer with a single scope: it enables only the **Service** scope — there is no instance or endpoint scope, no topology, and no traces or logs tabs. Everything you see is derived from the access traffic the calling agents reported, so the figures describe the database as seen by its clients, not by the database engine.

This page is the **operator reference** for the bundled Virtual Database dashboard: what you see on the scope and what each widget means.

> The widgets and metrics below are read from the bundled VIRTUAL_DATABASE template; if an operator has published a customized VIRTUAL_DATABASE template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a database, the layer landing page lists every virtual database with four sortable columns, sorted by **Access RPM** by default:

- **Access RPM** — accesses per minute against the database (`database_access_cpm`).

- **Latency** — average access latency in ms (`database_access_resp_time`).

- **p95** — 95th-percentile access latency in ms (`database_access_percentile{p='95'}`).

- **Error Rate** — percent of accesses that threw (`100 - database_access_sla/100`).

## Service dashboard

The primary drill-down for one selected database.

- **Access Traffic** — accesses per minute against the virtual database (`database_access_cpm`).

- **Avg Response Time** — mean access latency in ms (`database_access_resp_time`).

- **Success Rate** — percent of accesses that returned without throwing (`database_access_sla/100`).

- **Response Time Percentile** — p50 / p75 / p90 / p95 / p99 access latency, the tail of the access-time distribution (`database_access_percentile`).

- **Slow Statements** — the top 20 slowest captured statements against this database, in ms, worst-first (`top_n(top_n_database_statement, 20, des)`). Each row is a single statement execution; click a row to copy the statement text, or use the trace icon at the row head to open its originating trace — shown only when the sample carries one. Reads `no data` when OAP captured no statements in the window.

## Requirements

The Virtual Database dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs your services instrumented by SkyWalking language agents that capture database calls, which produces:

- **Database access metrics** — the `database_access_*` family: `database_access_cpm` (traffic), `database_access_resp_time` (latency), `database_access_sla` (success rate), and `database_access_percentile` (the latency tail). These back both the Service list and the Service dashboard.

- **Sampled statements** — `top_n_database_statement` for the Slow Statements list, captured by OAP when slow-statement sampling is configured on the calling services.

Each metric is queried at its own OAP scope; the whole layer lives at the service (database) scope, so the dashboard is empty until at least one instrumented service reports database access traffic. For the upstream setup — how virtual databases are detected and configured — see the [virtual database documentation](https://skywalking.apache.org/docs/main/next/en/setup/service-agent/virtual-database/).
