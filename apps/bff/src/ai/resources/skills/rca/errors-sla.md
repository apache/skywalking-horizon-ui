---
id: errors-sla
title: Error rate / SLA drop
whenToUse: A service's success rate (SLA) falling or its error rate spiking — locate the failing endpoints, pull the error stack, and confirm whether the errors actually originate upstream.
---
Refines the root-cause master for error-rate / SLA drops. Ordering: root service -> calling chain -> error stack; upstream-first; catalog MQE verbatim, never invented.

1. list_alarms — is an alarm firing for the affected service (an SLA / error-rate rule)? If yes, read it for the entity and threshold. If not, treat as a near-miss (a real drop can sit just under an edge-case bound) and continue; formal rule inspection is not yet a tool.
2. Confirm the symptom at Service scope. kb_browse_catalog the service's page; kb_describe_metric the success-rate (SLA) and cpm entries and render with show_line. The signature is SLA dropping while cpm climbs. Use catalog MQE verbatim.
3. show_topology -> walk UPSTREAM. For each upstream dependency, re-run the SLA/cpm check. If an upstream is also unhealthy, it is likely the real cause — fix the upstream first. Keep climbing to the root service. If an upstream is an unmanaged Virtual_* remote, only the client-side edge metric exists — check it and stop. If the root service is backed by an infra/database layer, kb_resolve_hierarchy into it and check its error/connection metrics.
4. At the root service, drill scope — OAP does not roll up. kb_resolve_scope_drill to Endpoint scope and re-query the same SLA/cpm; show_top / show_table the top failing endpoints (outliers stand out).
5. kb_resolve_scope_drill to ServiceInstance scope -> re-query SLA plus runtime metrics (JVM / Node VM / host) with show_line; pick a few abnormal instances. For a k8s workload, read their pod logs now — list_pod_containers + fetch_pod_logs (instance attributes are not an assistant tool yet).
6. Error stack. On a k8s pod, fetch_pod_logs names the failure (filter status/errors with keywordsOfContent). Native trace queries (status=ERROR) + span logs are NOT an assistant tool yet — surface the failing-endpoint show_table and name trace inspection as the next step.
7. If the cause stays hidden. AVAILABLE now: show_deployment for a manifest / resource-limit fault; propose_profiling (JVM / Go / eBPF). NOT wired yet: the events feed (recent reboot?), git / code-line — name the relevant one rather than fabricating a call.
