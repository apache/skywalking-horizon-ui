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
# Linux

The **OS_LINUX** layer monitors Linux hosts. It is populated by OAP's Linux monitoring, which receives host metrics from Prometheus node-exporter, Telegraf, or the OpenTelemetry Collector `hostmetrics` receiver, and process metrics from the OpenTelemetry Collector process scraper — there is no language agent here, the data comes from the host telemetry.

In Horizon's sidebar this layer lives under the **OS** group and is named **Linux**. Each monitored host is listed as a **Host**, and each process group on it as a **Process**. This is a metrics-only layer: it enables the **Service** and **Instance** scopes and nothing else — there is no endpoint scope, no topology, and no traces or logs tabs.

This page is the **operator reference** for the bundled Linux dashboards: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled OS_LINUX template; if an operator has published a customized OS_LINUX template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Host list

Before opening a host, the layer landing page lists every Linux host with four sortable columns, sorted by **CPU total %** by default:

- **CPU total %** — host CPU utilization (`meter_vm_cpu_total_percentage`), on the same scale as the **CPU Across Cores** card below.

- **Memory MB** — memory in use, in MB (`meter_vm_memory_used/1024/1024`).

- **Load 1m** — the 1-minute load average (`meter_vm_cpu_load1/100`).

- **FS %** — filesystem space used, as a percent (`meter_vm_filesystem_percentage`).

## Host dashboard

The primary drill-down for one selected host. Some widgets exist only for one telemetry source; a widget whose source is not reporting for the host is hidden rather than shown empty.

**Status cards**

- **CPU Across Cores** — CPU in use right now (`latest(meter_vm_cpu_total_percentage)`). With node-exporter and hostmetrics it is summed across logical CPUs, so a fully busy 4-CPU host reads 400%; Telegraf reports a 0–100% value for the whole host.

- **Memory Used** — physical memory in use, in MB (`latest(meter_vm_memory_used)/1024/1024`).

- **Load 1m** — the 1-minute load average (`latest(meter_vm_cpu_load1)/100`).

- **Swap Used** — the percentage of swap space in use (`latest(meter_vm_memory_swap_percentage)`).

- **Normalized CPU** — CPU in use divided by the number of logical CPUs, on a 0–100% host scale (`latest(meter_vm_cpu_norm_percentage)`). OpenTelemetry hostmetrics only.

- **Logical CPUs** — the number of logical CPUs (`latest(meter_vm_cpu_cores_num)`). OpenTelemetry hostmetrics only.

**Time series**

- **CPU by State** — CPU utilization with one series per CPU state such as user, system and idle (`meter_vm_cpu_average_used`). With node-exporter and hostmetrics each state is summed across logical CPUs; Telegraf reports one series per CPU instead.

- **CPU Load** — the load average at three windows: 1m / 5m / 15m (`meter_vm_cpu_load1/100`, `meter_vm_cpu_load5/100`, `meter_vm_cpu_load15/100`).

- **Normalized CPU** — the Normalized CPU card over time (`meter_vm_cpu_norm_percentage`). OpenTelemetry hostmetrics only.

- **File FD Allocated** — the number of allocated file descriptors on the host (`meter_vm_filefd_allocated`). node-exporter only.

- **Memory RAM (MB)** — four series in MB: used / total / available / buff/cache (`meter_vm_memory_used/1024/1024`, `meter_vm_memory_total/1024/1024`, `meter_vm_memory_available/1024/1024`, `meter_vm_memory_buff_cache/1024/1024`). Telegraf reports no buff/cache series.

- **Memory Swap (MB)** — swap free vs swap total, in MB (`meter_vm_memory_swap_free/1024/1024`, `meter_vm_memory_swap_total/1024/1024`).

- **Network Bandwidth (KB/s)** — receive vs transmit throughput, in KB/s (`meter_vm_network_receive/1024`, `meter_vm_network_transmit/1024`).

- **Disk R/W (KB/s)** — disk read vs written throughput, in KB/s (`meter_vm_disk_read/1024`, `meter_vm_disk_written/1024`).

- **Filesystem Usage (%)** — filesystem space used, one series per mount point (`meter_vm_filesystem_percentage`).

- **TCP Connections** — established and time-wait TCP connections (`meter_vm_tcp_curr_estab`, `meter_vm_tcp_tw`).

- **Linux Socket Counters** — TCP alloc, sockets used, and UDP in-use (`meter_vm_tcp_alloc`, `meter_vm_sockets_used`, `meter_vm_udp_inuse`). node-exporter reports all three and Telegraf reports TCP alloc and UDP in-use; hidden with OpenTelemetry hostmetrics, which has no equivalent counters.

**Top processes**

Shown only when process metrics reach OAP for the host. Each panel ranks the host's top 10 process groups, with a tab per ranking:

- **Top Processes by CPU** — total / user / system CPU, as a share of the host's total CPU capacity (`top_n(mp_process_linux_cpu_total_percent,10,des)`, and the `_user_` / `_system_` variants).

- **Top Processes by Memory** — resident memory in MB, or resident memory as a percentage of host RAM (`top_n(mp_process_linux_memory_resident_bytes,10,des)/1024/1024`, `top_n(mp_process_linux_memory_resident_percent,10,des)/100`).

- **Top Processes by Resources** — threads / open file descriptors / number of OS processes in the group (`top_n(mp_process_linux_num_threads,10,des)`, `top_n(mp_process_linux_open_handles,10,des)`, `top_n(mp_process_linux_num_procs,10,des)`).

## Process dashboard

For one selected **Process**. A process is a group: every OS process on the host with the same normalized process name, combined by the OpenTelemetry Collector before it reaches OAP. CPU values here are a share of the host's total CPU capacity, so one fully busy core on a 4-CPU host reads 25% here while the host's **CPU Across Cores** card reads 100%.

**Status cards**

- **CPU Used** — CPU in use by the group (`latest(mp_process_linux_cpu_total_percent)`).

- **Resident Memory** — physical memory in use by the group, in MB (`latest(mp_process_linux_memory_resident_bytes)/1024/1024`).

- **Host Memory Used** — the group's resident memory as a percentage of host RAM (`latest(mp_process_linux_memory_resident_percent)/100`).

- **Processes** — the number of OS processes in the group (`latest(mp_process_linux_num_procs)`).

- **Threads** — threads across the group (`latest(mp_process_linux_num_threads)`).

- **Open File Descriptors** — open file descriptors across the group (`latest(mp_process_linux_open_handles)`).

- **Oldest Process Uptime** — how long the oldest process in the group has been running, in hours (`latest(mp_process_linux_oldest_process_uptime_seconds)/3600`).

**Time series**

- **CPU Usage** — total / user / system CPU (`mp_process_linux_cpu_total_percent`, `mp_process_linux_cpu_user_percent`, `mp_process_linux_cpu_system_percent`).

- **Resident Memory** — resident memory in MB (`mp_process_linux_memory_resident_bytes/1024/1024`).

- **Host Memory Used by Process** — resident memory as a percentage of host RAM (`mp_process_linux_memory_resident_percent/100`).

- **Processes and Threads** — process count on the right axis, thread count on the left (`mp_process_linux_num_procs`, `mp_process_linux_num_threads`).

- **Open File Descriptors** — open file descriptors across the group (`mp_process_linux_open_handles`).

- **Oldest Process Uptime** — the uptime card over time, in hours (`mp_process_linux_oldest_process_uptime_seconds/3600`). A drop means the oldest process in the group restarted or exited.

## Requirements

The Linux dashboards are a pure consumer of what OAP reports — they invent no data. To populate them, OAP needs:

- **Host (service-scope) meters** — the `meter_vm_*` family, from node-exporter (through an OpenTelemetry Collector), Telegraf, or the OpenTelemetry Collector `hostmetrics` receiver. Hostmetrics must be sent under the `vm-monitoring` job name, as OAP's reference Collector configuration does. These back the Host list and the Host dashboard.

- **Process (instance-scope) meters** — the `mp_process_linux_*` family, from the OpenTelemetry Collector process scraper sent under the `hostmetrics-process-monitoring-linux` job name, which the same reference configuration sets up. These back the Top Processes panels and the Process dashboard, and need an OAP release that ships the OpenTelemetry host and process monitoring rules.

The **Processes** tab is always part of this layer. Without the process scraper it lists no processes and the Top Processes panels are hidden; host monitoring is unaffected. For the setup steps — each source's configuration, the reference Collector configuration, and which OAP rules to enable — see the [Linux monitoring documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-vm-monitoring/).
