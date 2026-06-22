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
# Java Agent (Self-Observability)

The **SO11Y_JAVA_AGENT** layer is the self-observability view of the SkyWalking **Java agent itself** — not the services it instruments, but the health of the agent running inside each Java process. It surfaces the agent's own internal counters: how many tracing contexts it creates and finishes, how many it ignores, how many may have leaked, how often its interceptors error, and how long its tracing context bookkeeping takes. Use it to confirm an agent is healthy and to catch agent-side problems (context leaks, interceptor failures) that would otherwise be invisible from the application's own metrics.

In Horizon's sidebar this layer lives under the **Self-Observability** group and is named **Java Agent**. It has no service-level page: the layer reports per-agent, so its services are listed as **Agent services** and its instances as **Agents**, and the only drill-down it enables is the **Instance** (per-agent) dashboard. There is no Service, Endpoint, Topology, Traces, Logs, or profiling tab in this layer — agent self-observability is purely instance-scoped runtime telemetry.

This page is the **operator reference** for the bundled SO11Y_JAVA_AGENT dashboard: what you see on the agent dashboard and what each widget means.

> The widgets and metrics below are read from the bundled SO11Y_JAVA_AGENT template; if an operator has published a customized copy to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Agent list

The layer landing page lists every reporting agent (**Agents**). This layer defines no extra landing columns, so the list is the agent roster on its own — pick an agent to open its dashboard.

## Agent dashboard

The per-agent drill-down. Every widget is a time series of the agent's own internal counters; the counts are per-minute rates and the one timing widget is in milliseconds.

- **Tracing Context Creation / min** — how many tracing contexts the agent created per minute (`meter_java_agent_created_tracing_context_count`). This is the agent's working rate: each context corresponds to a traced execution it started tracking.
- **Tracing Created + Finished / min** — created vs. finished tracing contexts on one chart, so you can see the two lines track each other (`aggregate_labels(meter_java_agent_created_tracing_context_count,sum)` as **created**, `meter_java_agent_finished_tracing_context_count` as **finished**). A persistent gap where created outruns finished points at contexts that never closed.
- **Ignored Context Creation / min** — contexts the agent deliberately skipped tracing per minute (`meter_java_agent_created_ignored_context_count`), for example traffic matched by the agent's ignore/exclusion rules.
- **Ignored Created + Finished / min** — the created vs. finished pair for ignored contexts (`aggregate_labels(meter_java_agent_created_ignored_context_count,sum)` as **created**, `meter_java_agent_finished_ignored_context_count` as **finished**), the same balance check applied to the ignored path.
- **Possible Leaked Context / min** — contexts the agent suspects were leaked per minute (`meter_java_agent_possible_leaked_context_count`). A sustained non-zero line here is the headline agent-health warning: it usually means trace contexts are not being cleaned up correctly in the instrumented application.
- **Interceptor Error Count / min** — errors raised inside the agent's bytecode interceptors per minute (`meter_java_agent_interceptor_error_count`). Non-zero values flag a misbehaving or incompatible plugin and warrant a look at the agent log.
- **Tracing Context Execution Time (ms)** — the p50 / p75 / p90 / p95 / p99 distribution of how long the agent's tracing-context handling takes, in milliseconds (`relabels(meter_java_agent_tracing_context_execution_time_percentile,p='50,75,90,95,99',p='50,75,90,95,99')/1000000`). This is the agent's own overhead tail; the percentile values are converted from nanoseconds to milliseconds for display.

## Requirements

The SO11Y_JAVA_AGENT dashboard is a pure consumer of what the Java agent reports about itself — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, the Java agent must have its self-observability (so11y) meters enabled so OAP receives the `meter_java_agent_*` family:

- **Context counters** — `meter_java_agent_created_tracing_context_count`, `meter_java_agent_finished_tracing_context_count`, `meter_java_agent_created_ignored_context_count`, `meter_java_agent_finished_ignored_context_count`, and `meter_java_agent_possible_leaked_context_count` for the creation, created-vs-finished, ignored, and leaked widgets.
- **Interceptor errors** — `meter_java_agent_interceptor_error_count` for the interceptor error widget.
- **Execution-time percentiles** — `meter_java_agent_tracing_context_execution_time_percentile` for the execution-time tail.

All of these are reported at the **ServiceInstance** scope (one agent = one instance), which is why this layer has only the agent dashboard and no service, endpoint, or topology view. An agent that does not emit the self-observability meter family will appear in the list but render `no data` on every widget.
