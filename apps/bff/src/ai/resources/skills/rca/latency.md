---
id: latency
title: Latency / response-time degradation
whenToUse: Rising response time — percentile (p95/p99) or avg resp-time spikes, apdex dropping — whether or not an alarm fired, and you need to separate a load-driven rise from a code / GC / dependency-driven one.
---
Refines the root-cause master for latency. Ordering: root service -> calling chain -> error stack; upstream-first; catalog MQE verbatim, never invented.

1. list_alarms -> look for a response-time / percentile alarm on the suspect service. If one fired, read its entity + rule + threshold — that's your root pointer. If none fired, treat as a near-miss and proceed on the symptom; don't assume healthy.
2. Frame the symptom at Service scope. kb_browse_catalog / kb_search_metrics the service's (layer, Service) page -> pull the verbatim percentile MQE (p50/p75/p90/p95/p99) and the avg resp-time MQE; show_line. Read the shape: a p95/p99 spike over a flat p50 = tail latency (GC, locks, a few slow calls); the whole curve shifting up = systemic. Overlay cpm and SLA: cpm climbing in lockstep => load-driven; latency up with flat or falling cpm => code / GC / dependency-driven.
3. show_topology -> walk UPSTREAM. Check each dependency's resp-time. If an upstream is slow, fix it first — your spike is inherited, not owned. If the slow dependency is a Virtual_* remote absent from list_services, you only hold the client-side edge metric — check that edge resp-time and stop there. If the root service is backed by an infra/database layer, kb_resolve_hierarchy into it and check that layer's latency/connection metrics.
4. At the root service, drill (no auto-rollup). kb_resolve_scope_drill -> Endpoint scope, re-query the same percentile MQE, show_top / show_table for the worst endpoints. Then drill -> ServiceInstance scope, re-query resp-time, show_top — one hot instance = node-local cause.
5. Correlate runtime at the hot instance. kb_browse_catalog the instance runtime page (JVM GC / heap / CPU, Node VM...) -> show_line; line a p99 spike up against GC pauses or CPU saturation. Cross-check instance attributes (JVM version, host, jar+version) — attributes tool coming.
6. Deeper. AVAILABLE now: fetch_pod_logs on the worst pod's container for the error stack (k8s workloads); propose_profiling (JVM / Go / eBPF network-packet) for hot methods, lock contention, or network latency; show_deployment for a manifest / resource-limit fault. NOT an assistant tool yet: trace query + span logs, the events feed — name them as the operator's next step.
