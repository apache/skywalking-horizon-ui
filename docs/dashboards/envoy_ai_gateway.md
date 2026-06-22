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
# Envoy AI Gateway

The **ENVOY_AI_GATEWAY** layer monitors [Envoy AI Gateway](https://aigateway.envoyproxy.io/) deployments — the Envoy-based gateway that fronts LLM providers and models, routing chat / completion traffic to OpenAI, Anthropic, and other backends. SkyWalking turns the gateway's OpenTelemetry GenAI signals into request, latency, token, and streaming-quality metrics, broken down by provider and model, and lands them here.

In Horizon's sidebar this layer is grouped under **Gateways**. Its services are listed as **AI Gateways** and its instances as **Nodes**. The ENVOY_AI_GATEWAY layer enables the Service (AI Gateway) and Instance (Node) dashboards plus the Logs sub-tab. It does **not** ship an Endpoint dashboard, a topology / service-map view, or a Traces tab — the gateway is monitored entirely through its GenAI meter families, which carry no per-endpoint scope or call graph.

This page is the **operator reference** for the bundled ENVOY_AI_GATEWAY dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled ENVOY_AI_GATEWAY template; if an operator has published a customized template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a gateway, the layer landing page lists every AI Gateway with four sortable columns, sorted by traffic (**RPM**) by default:

- **RPM** — requests per minute across the gateway (`meter_envoy_ai_gw_request_cpm`).

- **Avg Latency** — average request latency in ms (`meter_envoy_ai_gw_request_latency_avg`).

- **Input Tokens/min** — input (prompt) token throughput per minute (`meter_envoy_ai_gw_input_token_rate`).

- **Output Tokens/min** — output (completion) token throughput per minute (`meter_envoy_ai_gw_output_token_rate`).

## Service dashboard

The primary drill-down for one selected AI Gateway. Beyond the headline request and token widgets, it breaks traffic down by GenAI provider and model and exposes streaming-quality timings (TTFT / TPOT). The Model Context Protocol (MCP) widgets only appear when the gateway actually serves MCP traffic.

**Requests, latency, and tokens**

- **Request RPM** — requests per minute for the gateway (`meter_envoy_ai_gw_request_cpm`).

- **Request Latency Avg** — average request latency in ms (`meter_envoy_ai_gw_request_latency_avg`).

- **Input Token Rate** — input (prompt) tokens per minute (`meter_envoy_ai_gw_input_token_rate`).

- **Output Token Rate** — output (completion) tokens per minute (`meter_envoy_ai_gw_output_token_rate`).

- **Request Latency Percentile** — p50 / p75 / p90 / p95 / p99 request latency, the tail of the latency distribution, in ms (`meter_envoy_ai_gw_request_latency_percentile`).

**Streaming quality**

- **TTFT (Time to First Token)** — time to first token for streaming responses, shown as both the average and the percentile distribution in ms (`meter_envoy_ai_gw_ttft_avg`, `meter_envoy_ai_gw_ttft_percentile`).

- **TPOT (Time Per Output Token)** — time per output token (inter-token latency) for streaming responses, shown as both the average and the percentile distribution in ms (`meter_envoy_ai_gw_tpot_avg`, `meter_envoy_ai_gw_tpot_percentile`).

**By provider** — each widget is split per `gen_ai_provider_name`, so every upstream LLM provider the gateway routes to gets its own series:

- **RPM by Provider** — requests per minute per provider (`meter_envoy_ai_gw_provider_request_cpm`).

- **Tokens by Provider** — token throughput per provider (`meter_envoy_ai_gw_provider_token_rate`).

- **Latency Avg by Provider** — average latency per provider, in ms (`meter_envoy_ai_gw_provider_latency_avg`).

**By model** — each widget is split per `gen_ai_response_model`, so every model the gateway answered with gets its own series:

- **RPM by Model** — requests per minute per model (`meter_envoy_ai_gw_model_request_cpm`).

- **Tokens by Model** — token throughput per model (`meter_envoy_ai_gw_model_token_rate`).

- **Latency Avg by Model** — average latency per model, in ms (`meter_envoy_ai_gw_model_latency_avg`).

- **TTFT by Model** — average time to first token per model, in ms (`meter_envoy_ai_gw_model_ttft_avg`).

- **TPOT by Model** — average time per output token per model, in ms (`meter_envoy_ai_gw_model_tpot_avg`).

**MCP (Model Context Protocol)** — these widgets render only when the gateway serves MCP traffic; on a gateway that never sees MCP requests they stay hidden rather than showing empty:

- **MCP RPM** — MCP requests per minute (`meter_envoy_ai_gw_mcp_request_cpm`).

- **MCP Avg Latency** — average MCP request latency in ms (`meter_envoy_ai_gw_mcp_request_latency_avg`).

- **MCP Error RPM** — MCP errors per minute (`meter_envoy_ai_gw_mcp_error_cpm`).

- **MCP by Method** — MCP requests per minute split per `mcp_method_name` (`meter_envoy_ai_gw_mcp_method_cpm`).

- **MCP by Backend** — MCP requests per minute split per `mcp_backend` (`meter_envoy_ai_gw_mcp_backend_request_cpm`).

## Instance dashboard

For one selected **Node** of the gateway. The same request, latency, token, and streaming-quality timings as the service view, scoped to a single gateway node.

- **Request RPM** — requests per minute for this node (`meter_envoy_ai_gw_instance_request_cpm`).

- **Request Latency Avg** — average request latency for this node, in ms (`meter_envoy_ai_gw_instance_request_latency_avg`).

- **Input Token Rate** — input (prompt) tokens per minute for this node (`meter_envoy_ai_gw_instance_input_token_rate`).

- **Output Token Rate** — output (completion) tokens per minute for this node (`meter_envoy_ai_gw_instance_output_token_rate`).

- **Request Latency Percentile** — p50 / p75 / p90 / p95 / p99 request latency for this node, in ms (`meter_envoy_ai_gw_instance_request_latency_percentile`).

- **TTFT** — time to first token for this node, shown as both the average and the percentile distribution in ms (`meter_envoy_ai_gw_instance_ttft_avg`, `meter_envoy_ai_gw_instance_ttft_percentile`).

- **TPOT** — time per output token for this node, shown as both the average and the percentile distribution in ms (`meter_envoy_ai_gw_instance_tpot_avg`, `meter_envoy_ai_gw_instance_tpot_percentile`).

## Requirements

The ENVOY_AI_GATEWAY dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs the Envoy AI Gateway GenAI meter families, derived from the gateway's OpenTelemetry GenAI signals:

- **Gateway (service) metrics** — the `meter_envoy_ai_gw_*` family at service scope: request load (`meter_envoy_ai_gw_request_cpm`), latency average and percentile (`meter_envoy_ai_gw_request_latency_avg`, `meter_envoy_ai_gw_request_latency_percentile`), input / output token rates (`meter_envoy_ai_gw_input_token_rate`, `meter_envoy_ai_gw_output_token_rate`), and the streaming-quality timings (`meter_envoy_ai_gw_ttft_*`, `meter_envoy_ai_gw_tpot_*`).

- **Per-provider and per-model metrics** — the `meter_envoy_ai_gw_provider_*` and `meter_envoy_ai_gw_model_*` families, labelled by `gen_ai_provider_name` and `gen_ai_response_model`, for the provider and model breakdown widgets.

- **MCP metrics** — the `meter_envoy_ai_gw_mcp_*` family (request, latency, error, per-method, per-backend), reported only when the gateway serves Model Context Protocol traffic; the MCP widgets stay hidden until these arrive.

- **Node (instance) metrics** — the `meter_envoy_ai_gw_instance_*` family for the per-node widgets (request load, latency, tokens, percentile, TTFT, TPOT).

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a node-scope metric is empty until that level of data is reported. For how to enable the upstream collector, see the [Envoy AI Gateway monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-envoy-ai-gateway-monitoring/) setup docs.
