---
id: k8s
title: Kubernetes workload root-cause
whenToUse: The symptom is on a Kubernetes workload — a K8S_SERVICE service/pod, or a service you traced down to its k8s pods: pods restarting or stuck, OOMKilled / CrashLoopBackOff, container CPU/memory saturation, or node pressure. Also the endgame when another playbook follows the hierarchy down into k8s.
---
Refines the root-cause master for Kubernetes workloads. k8s pod-lifecycle signal is METRICS-FIRST — OAP does NOT natively collect k8s Event objects, so pod restarts / OOMKilled / CrashLoopBackOff surface as METRICS (a status metric carrying a reason tag), not an events feed. Order: root service -> calling chain -> error stack; upstream-first; catalog MQE verbatim, never invented.

WHICH LAYER to read:
- K8S_SERVICE (richest, start here): a k8s Service at Service scope, a POD at ServiceInstance scope, an API at Endpoint scope — HTTP/TCP golden metrics + pod resources + pod status.
- K8S: the CLUSTER at Service scope, a NODE at ServiceInstance scope — node/cluster CPU/memory/storage/pod counts. Go here for node pressure.
- CILIUM_SERVICE: eBPF L4 / HTTP / DNS network signal (drops, non-2xx) when the fault looks network-side.
- AWS_EKS: the same on EKS via CloudWatch.

1. list_alarms — a firing alarm on the k8s Service names the entity. None? Near-miss; continue.
2. Confirm the symptom at K8S_SERVICE Service scope. kb_browse_catalog(K8S_SERVICE, service); show_line the HTTP success / RPM / response-time SERIES, and show_table the Pod Restarts / Pods Waiting counts (they are latest()-wrapped labeled tables, not time series). Restarts climbing or pods stuck Waiting is the k8s tell.
3. Pod status REASON. show_table the catalog's Pods Waiting and Pod Restarts tables (Pods Waiting carries a waiting-reason tag — CrashLoopBackOff, ImagePullBackOff, ContainerCreating). A climbing restart count plus a Waiting reason is the first real clue and points at the next move: a restart storm or OOM -> logs (step 5) and memory-limit headroom (step 6). Only Pods Waiting + Pod Restarts are bundled widgets on this layer — do not kb_search_metrics for a Terminated table, it is not in the catalog.
4. Drill to the outlier pod (no auto-rollup). kb_resolve_scope_drill(serviceId=<id>, toScope='instance') for the pod {id,name}; re-query the same metric per pod with show_top / show_table to find the bad pod.
5. Pod logs = the ERROR STACK. list_pod_containers(podId) then fetch_pod_logs(layer=K8S_SERVICE, serviceInstanceId=podId, container) — narrow with keywordsOfContent like ERROR / Exception / OOM. This is where a CrashLoop or an app exception is finally named. On-demand logs are OAP-gated; if disabled the tool says so — fall back to metrics + node pressure.
6. Limits vs usage HEADROOM. Overlay the pod's CPU/Memory Resources (requests + limits) against Pod CPU/Memory Usage with show_line: usage pinned at the limit = CPU throttle or the OOM cause; usage climbing monotonically = a leak. This is the saturation fork for a container.
7. NODE pressure. If several pods on one node misbehave, the node is suspect: kb_browse_catalog(K8S, instance) for that node — k8s_node_ CPU / memory / storage; a full-disk or memory-pressured node evicts and restarts pods. Cluster-wide: kb_browse_catalog(K8S, service) for pods-not-running / allocatable headroom.
8. Cross-layer hierarchy — BOTH directions. UP: kb_resolve_hierarchy from the K8S_SERVICE to the app service (GENERAL / MESH) that owns the request, to tie the pod fault to the user-facing symptom. DOWN: if the workload IS a backing store (a PostgreSQL / MongoDB / Kafka pod), continue root-cause on that infra layer's own metrics (slow query, connections, disk).
9. Network-side (optional). If HTTP/TCP errors look network-driven not app-driven, CILIUM_SERVICE (or the K8S_SERVICE TCP metrics) show drops / non-2xx / retransmits on the wire.
