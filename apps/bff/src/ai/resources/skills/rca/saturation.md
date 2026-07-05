---
id: saturation
title: Traffic surge & resource saturation
whenToUse: Traffic (cpm) climbing with resource pressure — latency/errors rising alongside load — or when you need to tell a genuine demand surge apart from a capacity ceiling or a resource leak on specific instances.
---
Refines the root-cause master for load/saturation. Ordering: root service -> calling chain -> error stack; upstream-first; catalog MQE verbatim, never invented.

1. list_alarms — pull active alarms for the symptom service. Expect an SLA-drop or cpm/latency alarm; if it fired, read it. If none did, treat the surge as a near-miss and continue.
2. list_services / list_layers -> confirm the service and its layer. Pull Service-scope MQE verbatim from kb_browse_catalog: render SLA and cpm with show_line. Confirm SLA falling while cpm climbs — the saturation signature.
3. show_topology -> walk UPSTREAM. If an upstream caller is unhealthy, it is the real root — fix it first. If an upstream dependency is a Virtual_* remote, only the client-side edge metric exists — check it and stop. Land on the service that actually owns the load = root service. If it is backed by an infra/database layer, kb_resolve_hierarchy into it (memory/disk/connection saturation often lives there).
4. kb_resolve_scope_drill -> ServiceInstance scope. OAP does not roll up between scopes — re-query the same cpm/latency metric per instance. show_top / show_table to rank instances and surface the saturated outlier(s).
5. For each outlier, kb_browse_catalog the ServiceInstance runtime scope — JVM heap / GC time / thread count, or host / Node VM CPU & memory — then kb_describe_metric and show_line against the cpm curve. Decision fork: resources tracking cpm linearly across all instances = genuine load surge (scale out); one instance's heap climbing monotonically with rising GC while cpm is flat = leak; resources pinned at a ceiling = capacity limit.
6. kb_resolve_scope_drill -> Endpoint scope; show_top endpoints by cpm to see if one API drives the surge.
7. show_deployment (available) — inspect for under-provisioned limits / missing HPA that turns a surge into saturation.
8. Error stack + deeper. AVAILABLE now: fetch_pod_logs on the outlier pod — the error stack (OOM, thread-pool or connection-pool exhaustion) usually names the cause; propose_profiling (JVM async / pprof / eBPF network) if a profile would confirm it. NOT an assistant tool yet (do not fabricate): the events feed (recent reboot/rescale), instance attributes, trace + span logs, git code-line — name them as the operator's next move.
