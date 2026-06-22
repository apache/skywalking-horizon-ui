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

The **OS_WINDOWS** layer monitors Windows hosts. It is populated by OAP's Windows monitoring, which receives host telemetry (CPU, memory, network, disk) and turns it into SkyWalking meters — there is no language agent here, the data comes from the host telemetry.

In Horizon's sidebar this layer lives under the **OS** group and is named **Windows**. Each monitored Windows machine is listed as a **Host**. This is a metrics-only, single-scope layer: it enables the **Service** scope and nothing else — there is no instance or endpoint scope, no topology, and no traces or logs tabs.

This page is the **operator reference** for the bundled Windows dashboard: what you see and what each widget means.

> The widgets and metrics below are read from the bundled OS_WINDOWS template; if an operator has published a customized OS_WINDOWS template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Host list

Before opening a host, the layer landing page lists every Windows host with three sortable columns, sorted by **CPU %** by default:

- **CPU %** — average CPU utilization across the host (`meter_win_cpu_total_percentage`).

- **Memory MB** — physical memory used, in MB (`meter_win_memory_used/1024/1024`).

- **VMem %** — virtual-memory utilization percentage (`avg(meter_win_memory_virtual_memory_percentage)`).

## Host dashboard

The primary drill-down for one selected Windows host.

- **CPU Average Used (%)** — average CPU utilization over the window (`meter_win_cpu_average_used`).

- **Memory RAM (MB)** — physical memory in MB, three series: used / total / available (`meter_win_memory_used/1024/1024`, `meter_win_memory_total/1024/1024`, `meter_win_memory_available/1024/1024`).

- **Virtual Memory (MB)** — virtual (page-file backed) memory in MB, free vs total (`meter_win_memory_virtual_memory_free/1024/1024`, `meter_win_memory_virtual_memory_total/1024/1024`).

- **Network Bandwidth (KB/s)** — network throughput in KB/s, receive vs transmit (`meter_win_network_receive/1024`, `meter_win_network_transmit/1024`).

- **Disk R/W (KB/s)** — disk throughput in KB/s, read vs written (`meter_win_disk_read/1024`, `meter_win_disk_written/1024`).

## Requirements

The Windows dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs Windows monitoring enabled so it ingests host telemetry and produces the host (service-scope) `meter_win_*` family:

- **CPU** — `meter_win_cpu_total_percentage` and `meter_win_cpu_average_used` back the CPU column and the CPU widget.

- **Memory** — `meter_win_memory_used`, `meter_win_memory_total`, `meter_win_memory_available`, and the `meter_win_memory_virtual_memory_*` series back the memory columns and the RAM / virtual-memory widgets.

- **Network and disk** — `meter_win_network_receive` / `meter_win_network_transmit` and `meter_win_disk_read` / `meter_win_disk_written` back the network and disk throughput widgets.

Every metric is queried at the Service (host) scope; OAP does not roll a metric up across scopes, so the dashboard stays empty until per-host data is reported. For the upstream setup steps — host-telemetry collection and which OAP rules to enable — see the [Windows monitoring documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-win-monitoring/).
