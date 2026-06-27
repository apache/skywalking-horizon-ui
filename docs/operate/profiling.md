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

# Profiling

Profiling drills past metrics and traces into the call stacks, kernel events, and process-to-process conversations of a running service. Horizon surfaces SkyWalking's profiling capabilities as a set of per-layer tabs on the service you have selected: Trace Profiling, eBPF Profiling, Async Profiling, Network Profiling, and pprof. Each profiling tab only appears on a layer when OAP reports that the service supports that kind of profiling, so the tabs you see depend on the agent and platform behind the service.

Every profiling tab follows the same shape: a task list on the left, a New Task control to start a profiling run, and a result panel on the right that renders the captured data once OAP has fanned the task out to the relevant instances or processes. Results are shown as an indented stack tree or a flame graph, with a toggle between the two where both apply.

Task creation is consistent across every tab. The New Task control opens once you have selected its target — a service, or a service instance for Network Profiling. Inside the dialog, if the target cannot be profiled — no profilable processes, or no instances on the service — Create is disabled with the reason shown next to it, rather than a silently greyed-out control. You always see why a task cannot be started.

## Access control

Profiling is gated by two distinct permissions:

- `profile:enable` — required to **start** a profiling task (the New Task control). It is held by the operator role and above.

- `profile:read` — required to **view** profiling results. It is part of the read-only data catalog held by viewer, maintainer, and operator.

A viewer can therefore open a profiling tab and inspect existing results, but cannot create new tasks. See [Roles and Permissions](../access-control/rbac.md) for the full permission catalog.

## Trace Profiling

Trace Profiling samples the call stacks of slow trace segments. You start a task scoped to a service (and optionally a single endpoint), and the agent dumps CPU stacks from segments that exceed the task's threshold while the task is running.

To start a task, open the New Task dialog and set:

- **Endpoint name** — restrict sampling to one endpoint, or leave it as `(any)` to profile all endpoints on the service.

- **Start when** — begin immediately (`now`) or at a scheduled time.

- **Duration** — how long the task runs, in minutes.

- **Min threshold (ms)** — only segments slower than this are sampled.

- **Dump period (ms)** — how often a stack snapshot is taken while a sampled request runs.

- **Max sampling count** — the cap on how many segments the task collects.

Once the task has collected sampled traces, pick a trace from the **Sampled traces** list to load its spans. Select a profiled span and press **Analyze** to build its call tree. The result renders as either a **Tree** (indented stack table) or a **Flame** graph. A **Data mode** toggle switches between **Include children** (the whole span's time) and **Exclude children** (only the time spent in the span itself, with child-span windows subtracted). The eye icon on a task opens a detail panel with the task's parameters and the per-instance operation log.

## eBPF Profiling

eBPF Profiling samples kernel-level stacks from a process without an in-process agent, driven by [SkyWalking Rover](https://github.com/apache/skywalking-rover). It supports two capture targets:

- **ON_CPU** — where the process spends CPU time.

- **OFF_CPU** — where the process is blocked off CPU (waiting on locks, I/O, scheduling).

A task targets a service and, optionally, a set of process labels (leave the labels empty to profile all processes). You choose the target, a start time, and a duration in minutes. Open the New Task dialog from the selected service; if OAP reports no profilable processes for it, the dialog says so and Create stays disabled.

When you select a task, the result auto-analyzes. The filter bar lets you narrow the view:

- **Labels** — restrict the aggregation to the chosen process labels.

- **Aggregate** — **Count** (number of stack samples) or **Duration**. Duration is only available on **OFF_CPU** tasks, since off-CPU samples carry a blocked-time duration that on-CPU samples do not.

- **Processes** — pin specific processes from the capture; pinning re-runs the analysis immediately.

The result is shown as a **Flame** graph or a **Tree**, with a banner stating the wall-clock window the capture covers and how many schedules contributed.

## Async Profiling

Async Profiling runs the async-profiler against a live Java service, capturing JVM-level stacks without restarting the process. A task targets one or more service instances and one or more event types. The supported events are:

- `CPU`
- `ALLOC`
- `LOCK`
- `WALL`
- `CTIMER`
- `ITIMER`

You can select multiple instances and multiple events in a single task. After the task runs, choose which instances to include and which event type's tree to render, then press **Analyze**. Because a single task can collect several event types, the result panel has an **Event type** selector — switching it re-draws the flame graph for the selected JVM event (for example `EXECUTION_SAMPLE` for CPU/Wall/Timer events, `LOCK` for lock contention, or one of the object-allocation event types for `ALLOC`).

## pprof

pprof profiles a live Go service through the standard Go runtime profiler. Unlike Async Profiling, a pprof task captures exactly **one** event type, chosen from:

- `CPU`
- `HEAP`
- `BLOCK`
- `GOROUTINE`
- `MUTEX`
- `ALLOCS`
- `THREADCREATE`

The dialog adapts to the event you pick:

- `CPU`, `BLOCK`, and `MUTEX` are time-bounded captures and require a **Duration** (up to 15 minutes).

- `BLOCK` and `MUTEX` additionally take a **Dump period** sampling rate — for `BLOCK` it is a blocked-nanoseconds rate, for `MUTEX` a contention-occurrences rate; a value of `1` samples every event.

- `HEAP`, `GOROUTINE`, `ALLOCS`, and `THREADCREATE` are one-shot snapshots — they take no duration and no sampling rate, capturing the current state at the moment the task fires.

A task can target multiple Go service instances. After it runs, select the instances to include and press **Analyze** to render the single result tree as a flame graph.

## Network Profiling

Network Profiling captures the network conversations between processes of a service instance and renders them as a process-level topology. It mounts on a specific instance, which you pick inside the New Task dialog. The dialog lists the rover-monitored processes reporting on that instance; an instance with no such processes cannot be profiled — OAP rejects the task — so Create is disabled with that reason. Once a valid instance is chosen, the task defines which traffic to sample.

Each sampling rule scopes the capture — by URI pattern, by HTTP 4xx / 5xx responses, or by a minimum duration — and controls how much of each request and response body is collected. A network task keeps running until it is stopped, so the New Task dialog defines the sampling rules rather than a fixed duration.

The result is a **honeycomb topology**: each cell is a process, and the edges between them are the observed inter-process calls. Selecting an edge opens a detail panel with that process-to-process relation's metrics (call rate, latency, and bytes transferred) charted over the task's run window. The topology that drives this layout is the same process-relation data that powers the [3D Infrastructure Map](infra-3d-map.md).

## Troubleshooting

- **No profiling tabs on a layer** — OAP did not report profiling support for that service. Each tab requires the corresponding capability (trace, eBPF, async-profiler, network, or pprof), which depends on the agent or [Rover](https://github.com/apache/skywalking-rover) deployment behind the service.

- **New Task is unavailable** — you have not selected a service (or, for Network Profiling, an instance), or you lack `profile:enable`.

- **Create is disabled inside the New Task dialog** — the chosen target cannot be profiled, and the reason is shown next to the button: for eBPF, OAP reports no profilable processes for the service; for Network Profiling, the selected instance has no rover-monitored processes; for Async Profiling and pprof, the service has no instances.

- **Task list is empty after creating a task** — the task is created, but results only appear once OAP has dispatched it to the instances or processes and they report back. The view polls for the new task briefly; use the refresh control if it does not appear.

- **Analyze returns no data** — the task ran but collected no samples in the selected window or scope. For Trace Profiling, confirm the threshold was low enough to sample real traffic; for eBPF and pprof, confirm the chosen processes or instances were live during the capture.

## Related

- [Roles and Permissions](../access-control/rbac.md) — `profile:enable` and `profile:read`.

- [3D Infrastructure Map](infra-3d-map.md) — the process and instance topology that the network view draws on.
