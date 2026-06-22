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
# Virtual GenAI

The **VIRTUAL_GENAI** layer monitors the GenAI / LLM providers your services talk to — OpenAI, Anthropic, and other model backends — as **virtual** targets. There is no agent inside the provider; the data is synthesized from the GenAI calls that instrumented services make, so each provider appears as a service whose request load, latency, success rate, token throughput, and estimated cost are reconstructed from the client side, then broken down per model.

In Horizon's sidebar this layer is grouped under **Virtual targets** and named **Virtual GenAI**. Its services are listed as **GenAI Providers** and its instances as **Models**. The VIRTUAL_GENAI layer enables the Service (GenAI Provider) and Instance (Model) dashboards only — it does **not** ship an Endpoint dashboard, a topology / service-map view, or Traces / Logs tabs, because the providers are monitored entirely through their GenAI meter families, which carry no per-endpoint scope or call graph.

This page is the **operator reference** for the bundled VIRTUAL_GENAI dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled VIRTUAL_GENAI template; if an operator has published a customized VIRTUAL_GENAI template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a provider, the layer landing page lists every GenAI Provider with four sortable columns, sorted by traffic (**RPM**) by default:

- **RPM** — calls per minute to the provider (`gen_ai_provider_cpm`).

- **Latency** — average response time in ms (`gen_ai_provider_resp_time`).

- **Success Rate** — percent of successful calls (`gen_ai_provider_sla/100`).

- **Output Tokens** — total output (completion) tokens produced over the window (`latest(gen_ai_provider_output_tokens_sum)`).

## Service dashboard

The primary drill-down for one selected GenAI Provider. The dashboard covers the request golden signals, the latency tail, token throughput split into input and output, and an estimated spend.

- **Calls / min** — calls per minute to the provider (`gen_ai_provider_cpm`).

- **Avg Response Time** — mean response time in ms (`gen_ai_provider_resp_time`).

- **Success Rate** — percent of successful calls (`gen_ai_provider_sla/100`).

- **Latency Percentile** — p50 / p75 / p90 / p95 / p99 response time, the tail of the latency distribution, in ms (`gen_ai_provider_latency_percentile`).

- **Input Tokens** — input (prompt) token throughput, shown as the running total over the window and the per-call average (`latest(gen_ai_provider_input_tokens_sum)`, `gen_ai_provider_input_tokens_avg`).

- **Output Tokens** — output (completion) token throughput, shown as the running total over the window and the per-call average (`latest(gen_ai_provider_output_tokens_sum)`, `gen_ai_provider_output_tokens_avg`).

- **Estimated Cost** — estimated spend against the provider, shown as the total over the window and the per-call average (`latest(gen_ai_provider_total_estimated_cost)/1000000`, `gen_ai_provider_avg_estimated_cost/1000000`). OAP carries the cost in micro-units, so each series is divided by 1000000 to land in whole currency units.

## Instance dashboard

For one selected **Model** of the provider. The same golden signals as the Service view, scoped to a single model, plus a streaming time-to-first-token timing.

- **Calls / min** — calls per minute to this model (`gen_ai_model_call_cpm`).

- **Avg Latency** — mean latency for this model, in ms (`gen_ai_model_latency_avg`).

- **Success Rate** — percent of successful calls to this model (`gen_ai_model_sla/100`).

- **Latency Percentile** — p50 / p75 / p90 / p95 / p99 latency for this model, in ms (`gen_ai_model_latency_percentile`).

- **TTFT (Time to First Token)** — time to first token for streaming responses, shown as both the average and the percentile distribution, in ms (`gen_ai_model_ttft_avg`, `gen_ai_model_ttft_percentile`).

- **Input Tokens** — input (prompt) token throughput for this model, shown as the running total over the window and the per-call average (`latest(gen_ai_model_input_tokens_sum)`, `gen_ai_model_input_tokens_avg`).

- **Output Tokens** — output (completion) token throughput for this model, shown as the running total over the window and the per-call average (`latest(gen_ai_model_output_tokens_sum)`, `gen_ai_model_output_tokens_avg`).

- **Estimated Cost** — estimated spend against this model, shown as the total over the window and the per-call average (`latest(gen_ai_model_total_estimated_cost)/1000000`, `gen_ai_model_avg_estimated_cost/1000000`). As on the Service view, the micro-unit cost is divided by 1000000 to land in whole currency units.

## Requirements

The VIRTUAL_GENAI dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs:

- **Provider (service) metrics** — the `gen_ai_provider_*` family at Service scope: call load (`gen_ai_provider_cpm`), response time (`gen_ai_provider_resp_time`), SLA (`gen_ai_provider_sla`), latency percentile (`gen_ai_provider_latency_percentile`), input / output token sums and averages (`gen_ai_provider_input_tokens_*`, `gen_ai_provider_output_tokens_*`), and the estimated-cost totals and averages (`gen_ai_provider_total_estimated_cost`, `gen_ai_provider_avg_estimated_cost`).

- **Model (instance) metrics** — the `gen_ai_model_*` family at ServiceInstance scope: call load (`gen_ai_model_call_cpm`), latency average and percentile (`gen_ai_model_latency_avg`, `gen_ai_model_latency_percentile`), SLA (`gen_ai_model_sla`), the streaming time-to-first-token timings (`gen_ai_model_ttft_avg`, `gen_ai_model_ttft_percentile`), input / output token sums and averages (`gen_ai_model_input_tokens_*`, `gen_ai_model_output_tokens_*`), and the estimated-cost totals and averages (`gen_ai_model_total_estimated_cost`, `gen_ai_model_avg_estimated_cost`).

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a model-scope (instance) metric is empty until that level of data is reported. Virtual-GenAI data only appears when the services calling the provider are instrumented and OAP's virtual-GenAI analysis is enabled — see the [Virtual GenAI setup guide](https://skywalking.apache.org/docs/main/next/en/setup/service-agent/virtual-genai/) for how OAP derives these targets.
