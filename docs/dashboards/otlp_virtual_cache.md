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
# OTLP Virtual Cache

The **OTLP_VIRTUAL_CACHE** layer holds the caches that OpenTelemetry-instrumented services call, reconstructed from the callers' spans. A cache appears here when a CLIENT span of an **OpenTelemetry Service** names it, through `db.system.name` and the peer address or peer name the span carries; the cache itself reports nothing, so every figure describes it as its clients see it. The layer is kept apart from the agent path's Virtual Cache layer because its metrics come from a different engine under their own `otlp_*` names.

In Horizon's sidebar this layer is named **OTLP Virtual Cache** (grouped under **OpenTelemetry**, with the OTLP Service layer). Each cache is listed as one of the **Caches**. It is a virtual-target layer with a single scope: only the **Service** scope is enabled; there is no instance or endpoint scope, no topology, and no traces or logs tabs. The cache does appear as a node on the OpenTelemetry Service layer's topology, where the edges into it carry the calls.

This page is the **operator reference** for the bundled OTLP Virtual Cache dashboard.

> The widgets and metrics below are read from the bundled OTLP_VIRTUAL_CACHE template; if an operator has published a customized OTLP_VIRTUAL_CACHE template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md).

## Service list

The landing page lists every cache with three sortable columns, sorted by **Access RPM** by default:

- **Access RPM** — commands per minute, counted from the callers' spans (`otlp_cache_access_cpm`).

- **Latency** — average duration of those spans in ms (`otlp_cache_access_resp_time`).

- **Error Rate** — percent of them that failed: status ERROR, or an HTTP status of 400 or above (`100 - otlp_cache_access_sla/100`).

## Service dashboard

- **Access Traffic** — commands per minute (`otlp_cache_access_cpm`).

- **Avg Response Time** — mean latency of the callers' spans in ms (`otlp_cache_access_resp_time`).

- **Success Rate** — percent of the callers' spans that did not fail, as in the list (`otlp_cache_access_sla/100`).


## Requirements

The dashboard is a pure consumer of what OAP reports. To populate it, OAP needs the OTLP trace receiver with the `trace-analyzer` module's shipped rule file, and client spans that name the cache: `db.system.name` or `db.system` with `service.peer.name`, `peer.service`, or `server.address` and `server.port`. A span that names the system but no address or peer is filed under a cache named after its system, and its namespace when the span carries one, such as `redis`. For the upstream setup see the [OpenTelemetry trace analysis documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/trace-analyzer/#layers).
