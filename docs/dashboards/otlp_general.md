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
# OTLP Service

The **OTLP_GENERAL** layer holds the services whose spans arrive over the OpenTelemetry protocol and are analyzed by SkyWalking's Trace Analysis Language (TAL). OAP analyzes only the spans whose resource carries `service.layer=OTLP_GENERAL`, which an application sets through `OTEL_RESOURCE_ATTRIBUTES`; it registers a service here from their `service.name`, derives the metrics below from the spans themselves, and draws the topology from each span's peer. The OTLP trace receiver and the shipped TAL rule file produce the metrics and the topology; the Traces tab also needs OAP's TraceQL module, see [Requirements](#requirements). These services are kept apart from the **General Service** layer because their metrics come from a different engine under their own `otlp_*` names; a process that runs both a SkyWalking agent and an OpenTelemetry SDK appears in both layers.

In Horizon's sidebar the layer is named **OTLP Service** (grouped under **OpenTelemetry**, with the OTLP Virtual Database, OTLP Virtual Cache and OTLP Virtual MQ layers). It enables the **Service**, **Instance** and **Endpoint** scopes, the **Topology** and **Traces** tabs, and no profiling tabs, since those need SkyWalking agents. The Logs tab is off in the bundled template; see [Traces and logs](#traces-and-logs) for turning it on. The API-dependency tab is off: an OTLP span carries no parent endpoint, so there are no endpoint-to-endpoint relations to draw.

This page is the **operator reference** for the bundled OTLP Service dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled OTLP_GENERAL template; if an operator has published a customized OTLP_GENERAL template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a service, the layer landing page lists every OpenTelemetry service with four sortable columns, sorted by **RPM** by default:

- **RPM** — server and consumer spans per minute (`otlp_service_cpm`).

- **Apdex** — the Apdex score computed from the span latencies against the service's threshold in `service-apdex-threshold.yml` (`otlp_service_apdex/10000`).

- **Latency** — average server and consumer span duration in ms (`otlp_service_resp_time`).

- **Error Rate** — percent of server and consumer spans that failed: status ERROR, or an HTTP status of 400 or above (`100 - otlp_service_sla/100`).

## Service dashboard

The primary drill-down for one selected service.

- **Top 20 Endpoints** — the service's endpoints ranked by traffic, by response time, or by worst success rate, one tab each (`top_n(otlp_endpoint_cpm,20,des)`, `top_n(otlp_endpoint_resp_time,20,des)`, `top_n(otlp_endpoint_sla,20,asc)/100`). An HTTP span's endpoint is `<method> <route>`, so a route template such as `GET /:endpoint` stands for every request that matched it; a span with no route keeps its span name.

- **Traffic** — server and consumer spans per minute, counted by the TAL rule before the receiver's own head sampling, so it reflects what the SDK sent (`otlp_service_cpm`).

- **Error Rate** — percent of server and consumer spans that failed, as in the service list (`100 - otlp_service_sla/100`).

- **Apdex** — the Apdex score over the window (`otlp_service_apdex/10000`).

- **Response Time Percentile** — p50 / p75 / p90 / p95 / p99 of the server and consumer span latency, from the buckets the rule declares (`otlp_service_percentile`).

- **Avg Response Time** — mean server and consumer span duration in ms (`otlp_service_resp_time`).

- **Top 10 instances by load / slowest instances / instances by success rate** — the service's instances ranked by `otlp_service_instance_cpm`, `otlp_service_instance_resp_time` and `otlp_service_instance_sla`. Instances exist only when the SDK's resource carries `service.instance.id`; a service whose SDK does not set it shows `no data` here and has no instance scope to open.

## Instance dashboard

- **Service Instance Load** — server and consumer spans per minute reported by the selected instance (`otlp_service_instance_cpm`).

- **Service Instance Latency** — mean server and consumer span duration in ms (`otlp_service_instance_resp_time`).

- **Service Instance Success Rate** — percent of the instance's server and consumer spans that did not fail, as in the service list (`otlp_service_instance_sla/100`).

## Endpoint dashboard

- **Traffic** — server and consumer spans per minute on the selected endpoint (`otlp_endpoint_cpm`).

- **Response Time** — mean duration in ms (`otlp_endpoint_resp_time`).

- **Success Rate** — percent of the endpoint's spans that did not fail, as in the service list (`otlp_endpoint_sla/100`).

- **Response Time Percentile** — p50 / p75 / p90 / p95 / p99 of the endpoint's latency (`otlp_endpoint_percentile`).

## Topology

The topology is generated from the services' spans. Each call a service makes is drawn as an edge from the caller to the service that answered it. Nodes carry **RPM**, **SLA** and **Latency** from the service metrics above. Edges carry **RPM** (`otlp_service_relation_client_cpm`), **Avg response time** (`otlp_service_relation_client_resp_time`) and **SLA** (`otlp_service_relation_client_call_sla/100`), measured at the caller. Server-side **RPM** (`otlp_service_relation_server_cpm`) is only on the edges whose caller the callee's span can name: from `User` to a service called from outside, from a broker to its consumer, and from a gateway listed in `gateways.yml` to the service behind it. The databases, caches and brokers the calls reach are conjectured peers, which live in the OpenTelemetry virtual layers.

## Traces and logs

The Traces tab reads the native OTLP store through OAP's TraceQL endpoint, which is where the receiver keeps spans in its default `otlp` storage mode. OAP ships that endpoint off; [Requirements](#requirements) lists what turns it on. A deployment that runs the receiver in its `zipkin` conversion mode stores no native spans, so switch the layer's trace source to Zipkin in **Dashboard setup → Layer dashboards** there.

The tab's service picker lists the services stored under `OTLP_GENERAL`, the ones this layer analyzes, and leaves out the other layers' services, such as the sidecars of a service mesh that report their spans under `OTLP_MESH`, and those whose spans set no `service.layer`. The bundled template asks OAP for that list through its `serviceLayer` setting, see [Layer templates](../customization/layer-templates.md#traces). Search results are not narrowed, so a trace that passes through a sidecar still shows its spans.

The Logs tab is off in the bundled template. The OAP accepts OTLP logs and stores them by `service.name`, so once a collector exports logs to the OAP, enabling the `logs` component on this layer shows them for the matching service.

## Requirements

The dashboard is a pure consumer of what OAP reports and invents no data. It needs OAP 11.1.0 or later. To populate it, OAP needs the OTLP trace receiver with the `trace-analyzer` module's shipped rule file, and each application needs `service.layer=OTLP_GENERAL` among its resource attributes, for example `OTEL_RESOURCE_ATTRIBUTES=service.layer=OTLP_GENERAL`. Spans without it, a service mesh sidecar's among them, are stored and can be opened in a trace but are not analyzed, so they add no service to this layer. The rule file produces:

- **Service, instance and endpoint metrics** — the `otlp_service_*`, `otlp_service_instance_*` and `otlp_endpoint_*` families.

- **Relation metrics** — `otlp_service_relation_client_*` and `otlp_service_relation_server_cpm`, which back the topology.

The Traces tab needs more, since OAP ships the TraceQL module and its OTLP datasource off: set `SW_TRACEQL=default` and `SW_TRACEQL_ENABLE_DATASOURCE_OTLP=true` on OAP, and point Horizon's `oap.traceql` settings at it, see [OAP Connection → TraceQL trace stores](../setup/oap.md#traceql-trace-stores-oaptraceql).

Each metric is queried at its own OAP scope. For the upstream setup — the rule file, its settings and the conventions it reads — see the [OpenTelemetry trace analysis documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/trace-analyzer/).
