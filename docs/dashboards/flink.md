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
# Flink

The **FLINK** layer monitors an Apache Flink stream-processing cluster: the JobManager that coordinates the cluster, the TaskManagers that run the work, and the Flink jobs themselves. It is sourced from Flink's metric reporter via OpenTelemetry, so the dashboard reads the same JVM, slot, network, and checkpoint metrics Flink already exposes.

In Horizon's sidebar this layer is named **Flink**. Its three scopes are aliased to Flink's own vocabulary: services are listed as **Flink JobManagers**, instances as **TaskManagers**, and endpoints as **Jobs**. The FLINK layer enables the Service, Instance, and Endpoint sub-tabs only — it ships no topology, no traces, and no logs.

This page is the **operator reference** for the bundled FLINK dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled FLINK template; if an operator has published a customized FLINK template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a JobManager, the layer landing page lists every Flink JobManager with four sortable columns, sorted by **Running Jobs** by default. Each column is the latest reported value:

- **Running Jobs** — jobs currently running on this JobManager (`meter_flink_jobManager_running_job_number`).

- **TaskManagers** — TaskManagers registered with this JobManager (`meter_flink_jobManager_taskManagers_registered_number`).

- **Slots Available** — free task slots across the registered TaskManagers (`meter_flink_jobManager_taskManagers_slots_available`).

- **Slots Total** — total task slots across the registered TaskManagers (`meter_flink_jobManager_taskManagers_slots_total`).

## Service dashboard

The primary drill-down for one selected JobManager. The top row is four single-value cards, followed by the JobManager's JVM health, GC behavior, and a running-jobs ranking.

- **Running Jobs** — jobs currently running (`meter_flink_jobManager_running_job_number`).

- **TaskManagers** — registered TaskManagers (`meter_flink_jobManager_taskManagers_registered_number`).

- **Slots Total** — total task slots (`meter_flink_jobManager_taskManagers_slots_total`).

- **Slots Available** — free task slots (`meter_flink_jobManager_taskManagers_slots_available`).

- **JM JVM CPU Load (%)** — JobManager JVM CPU load (`meter_flink_jobManager_jvm_cpu_load`).

- **JM JVM Thread Count** — live JVM threads in the JobManager (`meter_flink_jobManager_jvm_thread_count`).

- **JM CPU Time (ms)** — JobManager JVM CPU time in ms (`meter_flink_jobManager_jvm_cpu_time`).

- **JM Heap (MB)** — JobManager heap memory, used vs available in MB (`meter_flink_jobManager_jvm_memory_heap_used`, `meter_flink_jobManager_jvm_memory_heap_available`).

- **JM NonHeap (MB)** — JobManager non-heap memory, used vs available in MB (`meter_flink_jobManager_jvm_memory_nonHeap_used`, `meter_flink_jobManager_jvm_memory_nonHeap_available`).

- **JM Metaspace (MB)** — JobManager metaspace, used vs available in MB (`meter_flink_jobManager_jvm_memory_metaspace_used`, `meter_flink_jobManager_jvm_memory_metaspace_available`).

- **G1 Young GC** — G1 young-generation collections on a dual axis: count on the left, time in ms on the right (`meter_flink_jobManager_jvm_g1_young_generation_count`, `meter_flink_jobManager_jvm_g1_young_generation_time`).

- **G1 Old GC** — G1 old-generation collections, count and time in ms on a dual axis (`meter_flink_jobManager_jvm_g1_old_generation_count`, `meter_flink_jobManager_jvm_g1_old_generation_time`).

- **All GC** — all garbage collectors combined, count and time in ms on a dual axis (`meter_flink_jobManager_jvm_all_garbageCollector_count`, `meter_flink_jobManager_jvm_all_garbageCollector_time`).

- **Top 10 Running Jobs** — the ten jobs with the longest running time, ranked descending (`meter_flink_job_runningTime`).

## Instance dashboard

For one selected TaskManager — the JVM health and network/back-pressure detail of a single worker.

- **JVM CPU Load (%)** — TaskManager JVM CPU load (`meter_flink_taskManager_jvm_cpu_load`).

- **JVM Thread Count** — live JVM threads in the TaskManager (`meter_flink_taskManager_jvm_thread_count`).

- **CPU Time (ms)** — TaskManager JVM CPU time in ms (`meter_flink_taskManager_jvm_cpu_time`).

- **Back Pressured** — whether the TaskManager is currently back-pressured (`meter_flink_taskManager_isBackPressured`).

- **Heap (MB)** — TaskManager heap memory, used vs available in MB (`meter_flink_taskManager_jvm_memory_heap_used`, `meter_flink_taskManager_jvm_memory_heap_available`).

- **NonHeap (MB)** — TaskManager non-heap memory, used vs available in MB (`meter_flink_taskManager_jvm_memory_nonHeap_used`, `meter_flink_taskManager_jvm_memory_nonHeap_available`).

- **Metaspace (MB)** — TaskManager metaspace, used vs available in MB (`meter_flink_taskManager_jvm_memory_metaspace_used`, `meter_flink_taskManager_jvm_memory_metaspace_available`).

- **Records In / Out** — records read in and written out by the TaskManager (`meter_flink_taskManager_numRecordsIn`, `meter_flink_taskManager_numRecordsOut`).

- **Bytes In / Out / s** — bytes per second read in and written out (`meter_flink_taskManager_numBytesInPerSecond`, `meter_flink_taskManager_numBytesOutPerSecond`).

- **Netty Memory (MB)** — Netty network-shuffle memory, used vs available in MB (`meter_flink_taskManager_netty_usedMemory`, `meter_flink_taskManager_netty_availableMemory`).

- **Pool Usage (%)** — input vs output buffer-pool usage (`meter_flink_taskManager_inPoolUsage`, `meter_flink_taskManager_outPoolUsage`).

- **Back-Pressure Time (ms/s)** — per-second time the TaskManager spent in each state: soft back-pressure, hard back-pressure, idle, and busy (`meter_flink_taskManager_softBackPressuredTimeMsPerSecond`, `meter_flink_taskManager_hardBackPressuredTimeMsPerSecond`, `meter_flink_taskManager_idleTimeMsPerSecond`, `meter_flink_taskManager_busyTimeMsPerSecond`).

## Endpoint dashboard

For one selected Job — its lifecycle timing, checkpoint behavior, and throughput. The top row is four single-value cards.

- **Job Running Time (min)** — how long the job has been running, in minutes (`meter_flink_job_runningTime`).

- **Job Restarting Time (min)** — time the job has spent restarting, in minutes (`meter_flink_job_restartingTime`).

- **Job Cancelling Time (min)** — time the job has spent cancelling, in minutes (`meter_flink_job_cancellingTime`).

- **Job Restarts** — number of job restarts (`meter_flink_job_restart_number`).

- **Checkpoints** — checkpoint counts over the window: total, completed, failed, and in-progress (`meter_flink_job_checkpoints_total`, `meter_flink_job_checkpoints_completed`, `meter_flink_job_checkpoints_failed`, `meter_flink_job_checkpoints_inProgress`).

- **Last Checkpoint** — the most recent checkpoint on a dual axis: size in bytes on the left, duration in ms on the right (`meter_flink_job_lastCheckpointSize`, `meter_flink_job_lastCheckpointDuration`).

- **Current Emit Event Time Lag (ms)** — lag between event time and emit time, in ms (`meter_flink_job_currentEmitEventTimeLag`).

- **Records In / Out** — records read in and written out by the job (`meter_flink_job_numRecordsIn`, `meter_flink_job_numRecordsOut`).

- **Bytes In / Out / s** — bytes per second read in and written out (`meter_flink_job_numBytesInPerSecond`, `meter_flink_job_numBytesOutPerSecond`).

## Requirements

The FLINK dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs the Flink meter families produced from Flink's OpenTelemetry metric export:

- **JobManager metrics** — the `meter_flink_jobManager_*` family (running jobs, registered TaskManagers, slot totals, and JVM CPU / thread / memory / GC detail), driving the Service list and Service dashboard.

- **TaskManager metrics** — the `meter_flink_taskManager_*` family (JVM detail, record / byte throughput, Netty and buffer-pool usage, and back-pressure timing), driving the Instance dashboard.

- **Job metrics** — the `meter_flink_job_*` family (running / restarting / cancelling time, restarts, checkpoints, emit-time lag, and throughput), driving the Endpoint dashboard and the Top 10 Running Jobs ranking.

Each metric is queried at its own OAP scope, and OAP does not roll a metric up across scopes — a JobManager-, TaskManager-, or Job-scope metric is empty until that level of data is reported. To set up the Flink metric reporter and the OAP receiver, follow the [Flink monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-flink-monitoring/) setup guide.
