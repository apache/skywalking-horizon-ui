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

The **OS_LINUX** layer monitors Linux hosts. It is populated by OAP's VM monitoring, which scrapes a Prometheus node-exporter and turns the result into SkyWalking meters — there is no language agent here, the data comes from the exporter.

In Horizon's sidebar this layer lives under the **OS** group and is named **Linux**. Each monitored host is listed as a **Host**. This is a metrics-only, single-scope layer: it enables the **Service** scope and nothing else — there is no instance scope, no endpoint scope, no topology, and no traces or logs tabs.

This page is the **operator reference** for the bundled Linux dashboard: what you see on the host scope and what each widget means.

> The widgets and metrics below are read from the bundled OS_LINUX template; if an operator has published a customized OS_LINUX template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Host list

Before opening a host, the layer landing page lists every Linux host with four sortable columns, sorted by **CPU %** by default:

- **CPU %** — average CPU utilization across all cores (`meter_vm_cpu_total_percentage`).

- **Memory MB** — memory in use, in MB (`meter_vm_memory_used/1024/1024`).

- **Load 1m** — the 1-minute load average (`meter_vm_cpu_load1/100`).

- **FS %** — filesystem space used, as a percent (`meter_vm_filesystem_percentage`).

## Host dashboard

The primary drill-down for one selected host.

- **CPU Average Used (%)** — average CPU utilization across cores, as a percent (`meter_vm_cpu_average_used`).

- **CPU Load** — the load average at three windows: 1m / 5m / 15m (`meter_vm_cpu_load1/100`, `meter_vm_cpu_load5/100`, `meter_vm_cpu_load15/100`).

- **File FD Allocated** — the number of allocated file descriptors (`meter_vm_filefd_allocated`).

- **Memory RAM (MB)** — four series in MB: used / total / available / buff/cache (`meter_vm_memory_used/1024/1024`, `meter_vm_memory_total/1024/1024`, `meter_vm_memory_available/1024/1024`, `meter_vm_memory_buff_cache/1024/1024`).

- **Memory Swap (MB)** — swap free vs swap total, in MB (`meter_vm_memory_swap_free/1024/1024`, `meter_vm_memory_swap_total/1024/1024`).

- **Network Bandwidth (KB/s)** — receive vs transmit throughput, in KB/s (`meter_vm_network_receive/1024`, `meter_vm_network_transmit/1024`).

- **Disk R/W (KB/s)** — disk read vs written throughput, in KB/s (`meter_vm_disk_read/1024`, `meter_vm_disk_written/1024`).

- **Filesystem Usage (%)** — filesystem space used, as a percent (`meter_vm_filesystem_percentage`).

- **Network Status** — five socket / TCP counters: established TCP connections, TCP time-wait, TCP alloc, sockets used, and UDP in-use (`meter_vm_tcp_curr_estab`, `meter_vm_tcp_tw`, `meter_vm_tcp_alloc`, `meter_vm_sockets_used`, `meter_vm_udp_inuse`).

## Requirements

The Linux dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs VM monitoring enabled so it scrapes a node-exporter and produces:

- **Host (service-scope) meters** — the `meter_vm_*` family: CPU utilization and load average, memory (used / total / available / buff-cache / swap), file-descriptor allocation, network receive/transmit, disk read/written, filesystem usage, and the TCP / socket / UDP counters. These back the Host list and the Host dashboard.

Each metric is queried at its own OAP scope; because this layer is service-scope only, every widget reads the host-level `meter_vm_*` series and there is no instance- or endpoint-level rollup. For the upstream setup steps — node-exporter configuration and which OAP rules to enable — see the [VM monitoring documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-vm-monitoring/).
