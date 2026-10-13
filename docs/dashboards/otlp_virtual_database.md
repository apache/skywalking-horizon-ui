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
# OTLP Virtual Database

The **OTLP_VIRTUAL_DATABASE** layer holds the databases that OpenTelemetry-instrumented services call, reconstructed from the callers' spans. A database appears here when a CLIENT span of an **OpenTelemetry Service** names it, through `db.system.name` and the peer address or peer name the span carries; the database itself reports nothing, so every figure describes it as its clients see it. The layer is kept apart from the agent path's Virtual Database layer because its metrics come from a different engine under their own `otlp_*` names.

In Horizon's sidebar this layer is nested under the **OTLP Service** entry and is named **OTLP Virtual Database**. Each database is listed as one of the **Databases**. It is a virtual-target layer with a single scope: only the **Service** scope is enabled; there is no instance or endpoint scope, no topology, and no traces or logs tabs. The database does appear as a node on the OpenTelemetry Service layer's topology, where the edges into it carry the calls.

This page is the **operator reference** for the bundled OTLP Virtual Database dashboard.

> The widgets and metrics below are read from the bundled OTLP_VIRTUAL_DATABASE template; if an operator has published a customized OTLP_VIRTUAL_DATABASE template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md).

## Service list

The landing page lists every database with three sortable columns, sorted by **Access RPM** by default:

- **Access RPM** — queries per minute, counted from the callers' spans (`otlp_database_access_cpm`).

- **Latency** — average duration of those spans in ms (`otlp_database_access_resp_time`).

- **Error Rate** — percent of them whose status is ERROR (`100 - otlp_database_access_sla/100`).

## Service dashboard

- **Access Traffic** — queries per minute (`otlp_database_access_cpm`).

- **Avg Response Time** — mean latency of the callers' spans in ms (`otlp_database_access_resp_time`).

- **Success Rate** — percent of the callers' spans that did not end in ERROR (`otlp_database_access_sla/100`).

- **Slow Statements** — the top 20 slowest statements the shipped `otlp-slow-sql` rule recorded against this database, in ms, worst-first (`top_n(top_n_database_statement, 20, des)`). Each row is one statement execution; click a row to copy the statement, or use the trace icon at the row head to open its trace. The rule records a statement at 200 ms or more by default; the threshold is in the rule file.

## Databases without an address

An embedded or in-process database reports no address in its spans. The OAP names such a database after its system and namespace, `h2/mem-db`, so it still appears in this list with its access metrics and slow statements, next to the address-named databases.

## Requirements

The dashboard is a pure consumer of what OAP reports. To populate it, OAP needs the OTLP trace receiver with the `trace-analyzer` module's shipped rule file, and client spans that name the database: `db.system.name` or `db.system` with `service.peer.name`, `peer.service`, or `server.address` and `server.port`. A span that names the system but no address or peer produces no database here. For the upstream setup see the [OpenTelemetry trace analysis documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/trace-analyzer/#layers).
