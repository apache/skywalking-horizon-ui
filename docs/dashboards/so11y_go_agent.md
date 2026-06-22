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
# Go Agent (Self-Observability)

The **SO11Y_GO_AGENT** layer is the self-observability view of the SkyWalking Go agent itself. It does not measure the application the agent instruments — it measures the agent's own tracing machinery: how many tracing contexts it creates and finishes, how many it ignores, where contexts may have leaked, and how long the agent spends building them. Use it to confirm a Go agent is healthy and not accumulating leaked contexts or interceptor errors.

In Horizon's sidebar this layer is grouped under **Self-Observability** and named **Go Agent**. Its services are listed as **Agent services** and its instances as **Agents** — each Agent is one running Go process reporting these meters. This is an instance-only layer: it enables the **Instance** sub-tab and nothing else. There is no Service dashboard, no Endpoint dashboard, no Topology, and no Traces or Logs tabs — the agent reports a flat set of self-observability meters per process, with no service-, endpoint-, or relation-scoped data behind them.

This page is the **operator reference** for the bundled SO11Y_GO_AGENT dashboard: what you see on the Agent (instance) scope and what each widget means.

> The widgets and metrics below are read from the bundled SO11Y_GO_AGENT template; if an operator has published a customized SO11Y_GO_AGENT template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Agent list

Selecting the layer lists the **Agent services**, and under one Agent service its **Agents** (instances) — one row per reporting Go process. This layer adds no extra landing columns, so the list is the plain name list; pick an Agent to open its dashboard.

## Instance dashboard

For one selected Agent (instance). Every widget on this dashboard is a Go-agent self-observability meter, charted over the selected time window.

- **Tracing Context Creation / min** — tracing contexts the agent created per minute (`meter_sw_go_created_tracing_context_count`). This is the agent's working rate — how many trace contexts it is spinning up to follow requests.

- **Tracing Created + Finished / min** — created vs finished tracing contexts per minute on one chart: the **created** series (`aggregate_labels(meter_sw_go_created_tracing_context_count,sum)`) against the **finished** series (`meter_sw_go_finished_tracing_context_count`). In a healthy agent the two lines track each other; a persistent gap (created running ahead of finished) is the signal that contexts are not being closed.

- **Ignored Context Creation / min** — contexts the agent created but deliberately ignored per minute (`meter_sw_go_created_ignored_context_count`), e.g. traffic filtered out of tracing.

- **Ignored Created + Finished / min** — the same created-vs-finished comparison for ignored contexts: **created** (`aggregate_labels(meter_sw_go_created_ignored_context_count,sum)`) against **finished** (`meter_sw_go_finished_ignored_context_count`).

- **Possible Leaked Context / min** — contexts the agent flags as possibly leaked per minute (`meter_sw_go_possible_leaked_context_count`). A non-zero, sustained line here points at instrumentation that opens a context without closing it — the key health signal on this dashboard.

- **Interceptor Error Count / min** — errors raised inside the agent's interceptors per minute (`meter_sw_go_interceptor_error_count`). Rising values indicate the agent is failing while wrapping calls, which can mean lost or incomplete traces.

- **Tracing Context Execution Time (ms)** — the time the agent spends building a tracing context, as a p50 / p75 / p90 / p95 / p99 latency distribution in milliseconds (`relabels(meter_sw_go_tracing_context_execution_time_percentile,p='50,75,90,95,99',p='50,75,90,95,99')/1000000`). The agent reports this percentile in nanoseconds, so the dashboard divides by 1,000,000 to display milliseconds. Watch the tail (p95 / p99) for instrumentation overhead.

## Requirements

The SO11Y_GO_AGENT dashboard is a pure consumer of what the Go agent reports through OAP — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs the Go agent's self-observability meter family at instance scope:

- **Agent self-observability meters** — the `meter_sw_go_*` family: created / finished / ignored / leaked tracing-context counts, interceptor error count, and the tracing-context execution-time percentile. These are emitted by the SkyWalking Go agent's own self-observability reporting, not derived from the traced application.

Every metric here is queried at the ServiceInstance (Agent) scope; OAP does not roll a metric up across scopes, so the dashboard stays empty until a Go agent is actively reporting these meters. When the meter family is missing entirely — for example a Go agent build with self-observability disabled — the widgets render `no data` rather than failing.
