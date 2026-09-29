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
# Windows

The **OS_WINDOWS** layer monitors Windows hosts. It is populated by OAP's Windows monitoring, which receives host metrics from Prometheus windows_exporter or from the OpenTelemetry Collector (its `hostmetrics` receiver plus Windows Performance Counters), and process metrics from the OpenTelemetry Collector process scraper — there is no language agent here, the data comes from the host telemetry.

In Horizon's sidebar this layer lives under the **OS** group and is named **Windows**. Each monitored Windows machine is listed as a **Host**, and each process group on it as a **Process**. This is a metrics-only layer: it enables the **Service** and **Instance** scopes and nothing else — there is no endpoint scope, no topology, and no traces or logs tabs.

This page is the **operator reference** for the bundled Windows dashboards: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled OS_WINDOWS template; if an operator has published a customized OS_WINDOWS template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Host list

Before opening a host, the layer landing page lists every Windows host with three sortable columns, sorted by **CPU total %** by default:

- **CPU total %** — host CPU utilization (`meter_win_cpu_total_percentage`), on the same scale as the **CPU Across Cores** card below.

- **Memory MB** — physical memory used, in MB (`meter_win_memory_used/1024/1024`).

- **Committed %** — committed memory as a percentage of the Windows commit limit (`avg(meter_win_memory_virtual_memory_percentage)`).

## Host dashboard

The primary drill-down for one selected Windows host. Some widgets exist only for one telemetry source; a widget whose source is not reporting for the host is hidden rather than shown empty.

**Status cards**

- **CPU Across Cores** — CPU in use right now, summed across logical CPUs, so a fully busy 4-CPU host reads 400% (`latest(meter_win_cpu_total_percentage)`).

- **Memory Used** — physical memory in use, in MB (`latest(meter_win_memory_used)/1024/1024`).

- **Committed Memory Used** — committed memory as a percentage of the Windows commit limit (`latest(meter_win_memory_virtual_memory_percentage)`).

- **Normalized CPU** — user and system CPU divided by the number of logical CPUs, on a 0–100% host scale (`latest(meter_win_cpu_norm_percentage)`). OpenTelemetry only.

- **Logical CPUs** — the number of logical CPUs (`latest(meter_win_cpu_cores_num)`). OpenTelemetry only.

- **Pagefile Used** — the percentage of the paging file in use (`latest(meter_win_memory_pagefile_percentage)`). OpenTelemetry only.

**Time series**

- **CPU by State (sum across cores)** — CPU utilization with one series per CPU state, each summed across logical CPUs (`meter_win_cpu_average_used`). Some Windows states overlap, so the series can add up to more than the host has; use **Normalized CPU** for a non-overlapping 0–100% value.

- **Memory RAM (MB)** — physical memory in MB, three series: used / total / available (`meter_win_memory_used/1024/1024`, `meter_win_memory_total/1024/1024`, `meter_win_memory_available/1024/1024`).

- **Committed Virtual Memory (MB)** — the Windows commit limit, and how much of it is still free (commit limit minus committed bytes), in MB (`meter_win_memory_virtual_memory_free/1024/1024`, `meter_win_memory_virtual_memory_total/1024/1024`). This is not the paging-file size.

- **Network Bandwidth (KB/s)** — network throughput in KB/s, receive vs transmit (`meter_win_network_receive/1024`, `meter_win_network_transmit/1024`).

- **Disk R/W (KB/s)** — disk throughput in KB/s, read vs written (`meter_win_disk_read/1024`, `meter_win_disk_written/1024`).

- **CPU Load** — the processor queue length as 1m / 5m / 15m averages (`meter_win_cpu_load1/100`, `meter_win_cpu_load5/100`, `meter_win_cpu_load15/100`). OpenTelemetry only.

- **Allocated Handles** — handles allocated across the whole system (`meter_win_filehandles_allocated`). OpenTelemetry only.

- **Windows Pagefile (MB)** — paging-file free vs total, in MB (`meter_win_memory_pagefile_free/1024/1024`, `meter_win_memory_pagefile_total/1024/1024`). OpenTelemetry only.

- **Filesystem Usage (%)** — space used, one series per volume or mount point (`meter_win_filesystem_percentage`). OpenTelemetry only.

**Top processes**

Shown only when process metrics reach OAP for the host. Each panel ranks the host's top 10 process groups, with a tab per ranking:

- **Top Processes by CPU** — total / user / system CPU, as a share of the host's total CPU capacity (`top_n(mp_process_windows_cpu_total_percent,10,des)`, and the `_user_` / `_system_` variants).

- **Top Processes by Memory** — resident memory in MB, or resident memory as a percentage of host RAM (`top_n(mp_process_windows_memory_resident_bytes,10,des)/1024/1024`, `top_n(mp_process_windows_memory_resident_percent,10,des)/100`).

- **Top Processes by Resources** — threads / open handles / number of processes in the group (`top_n(mp_process_windows_num_threads,10,des)`, `top_n(mp_process_windows_open_handles,10,des)`, `top_n(mp_process_windows_num_procs,10,des)`).

## Process dashboard

For one selected **Process**. A process is a group: every process (PID) on the host with the same normalized process name, combined by the OpenTelemetry Collector before it reaches OAP. CPU values here are a share of the host's total CPU capacity, so one fully busy core on a 4-CPU host reads 25% here while the host's **CPU Across Cores** card reads 100%.

**Status cards**

- **CPU Used** — CPU in use by the group (`latest(mp_process_windows_cpu_total_percent)`).

- **Resident Memory** — physical memory in use by the group, in MB (`latest(mp_process_windows_memory_resident_bytes)/1024/1024`).

- **Host Memory Used** — the group's resident memory as a percentage of host RAM (`latest(mp_process_windows_memory_resident_percent)/100`).

- **Processes** — the number of PIDs in the group (`latest(mp_process_windows_num_procs)`).

- **Threads** — threads across the group (`latest(mp_process_windows_num_threads)`).

- **Open Handles** — open handles across the group (`latest(mp_process_windows_open_handles)`).

- **Oldest Process Uptime** — how long the oldest PID in the group has been running, in hours (`latest(mp_process_windows_oldest_process_uptime_seconds)/3600`).

**Time series**

- **CPU Usage** — total / user / system CPU (`mp_process_windows_cpu_total_percent`, `mp_process_windows_cpu_user_percent`, `mp_process_windows_cpu_system_percent`).

- **Resident Memory** — resident memory in MB (`mp_process_windows_memory_resident_bytes/1024/1024`).

- **Host Memory Used by Process** — resident memory as a percentage of host RAM (`mp_process_windows_memory_resident_percent/100`).

- **Processes and Threads** — PID count on the right axis, thread count on the left (`mp_process_windows_num_procs`, `mp_process_windows_num_threads`).

- **Open Handles** — open handles across the group (`mp_process_windows_open_handles`).

- **Oldest Process Uptime** — the uptime card over time, in hours (`mp_process_windows_oldest_process_uptime_seconds/3600`). A drop means the oldest PID in the group restarted or exited.

## Requirements

The Windows dashboards are a pure consumer of what OAP reports — they invent no data. To populate them, OAP needs:

- **Host (service-scope) meters** — the `meter_win_*` family, from windows_exporter (through an OpenTelemetry Collector) or from the OpenTelemetry Collector using OAP's reference Windows configuration, which sends them under the `windows-monitoring` job name. These back the Host list and the Host dashboard.

- **Process (instance-scope) meters** — the `mp_process_windows_*` family, from the OpenTelemetry Collector process scraper sent under the `hostmetrics-process-monitoring-windows` job name, which the same reference configuration sets up. These back the Top Processes panels and the Process dashboard, and need an OAP release that ships the OpenTelemetry host and process monitoring rules.

The **Processes** tab is always part of this layer. Without the process scraper it lists no processes and the Top Processes panels are hidden; host monitoring is unaffected. For the setup steps — windows_exporter, the reference Collector configuration, and which OAP rules to enable — see the [Windows monitoring documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-win-monitoring/).
