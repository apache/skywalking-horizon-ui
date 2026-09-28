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

The **OS_WINDOWS** layer monitors Windows hosts from host telemetry collected by SkyWalking OAP. Hosts are represented as **Hosts** at the Service scope, while process groups collected by the OpenTelemetry process scraper are represented as **Processes** at the Service Instance scope.

In Horizon's sidebar this layer lives under the **OS** group and is named **Windows**. The layer is metrics-only: it exposes **Hosts** and **Processes**, but no endpoint, topology, traces, or logs tabs.

This page is the **operator reference** for the bundled Windows dashboards: what is shown at the host and process scopes, and which telemetry is required.

> The widgets and metrics below are read from the bundled OS_WINDOWS template; if an operator has published a customized OS_WINDOWS template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Host list

Before opening a host, the layer landing page lists every Windows host with three sortable columns, sorted by **CPU total %** by default:

* **CPU total %** — host CPU utilization (`meter_win_cpu_total_percentage`).
* **Memory MB** — physical memory used, in MB (`meter_win_memory_used/1024/1024`).
* **Committed %** — committed virtual-memory utilization (`avg(meter_win_memory_virtual_memory_percentage)`).

## Host dashboard

The Host dashboard combines metrics available from the existing Windows monitoring source with additional metrics available from OpenTelemetry hostmetrics and performance counters.

The summary cards include:

* **CPU Across Cores** — current host CPU utilization.
* **Memory Used** — current physical memory in use.
* **Committed Memory Used** — committed virtual memory as a percentage of the Windows commit limit.
* **Normalized CPU** — non-overlapping user and system CPU normalized to the conventional 0–100% host scale when available.
* **Logical CPUs** — logical processor count reported by OpenTelemetry hostmetrics.
* **Pagefile Used** — current paging-file utilization when reported by the OpenTelemetry performance counters.

The historical charts include:

* **CPU by State** — CPU utilization by reported processor state.
* **Memory RAM (MB)** — used / total / available physical memory.
* **Committed Virtual Memory (MB)** — committed bytes and the Windows commit limit.
* **Network Bandwidth (KB/s)** — receive vs transmit throughput.
* **Disk R/W (KB/s)** — disk read vs written throughput.
* **CPU Load** — Windows processor queue length represented as 1m / 5m / 15m averages when available.
* **Allocated Handles** — total handles allocated by Windows processes when available.
* **Windows Pagefile (MB)** — free and total paging-file capacity when available.
* **Filesystem Usage (%)** — utilization of Windows volumes or mount points.

Widgets whose backing metrics are unavailable are hidden automatically.

## Top Processes

When the OpenTelemetry process scraper is enabled, the Host dashboard also shows three Top Process panels:

* **Top Processes by CPU** — process groups ranked by total, user, or system CPU.
* **Top Processes by Memory** — process groups ranked by resident memory or host-memory percentage.
* **Top Processes by Resources** — process groups ranked by threads, open handles, or grouped PID count.

These panels are hidden when process metrics are not available.

## Processes dashboard

The **Processes** page represents normalized Windows process groups reported as Service Instances.

For a selected process group Horizon shows current values for:

* CPU utilization;
* resident physical memory;
* percentage of host memory;
* grouped PID count;
* threads;
* open handles;
* oldest process uptime.

Historical charts show CPU, resident memory, host-memory percentage, process and thread counts, open handles, and oldest-process uptime.

The **Processes** tab is part of the bundled OS_WINDOWS layer. If the OpenTelemetry process scraper is not running, the tab has no process entities to display.

## Requirements

The Host dashboard consumes the `meter_win_*` metrics produced by the OAP Windows monitoring rules.

For OpenTelemetry hostmetrics, configure the Collector to send Windows host metrics through the `windows-monitoring` job. OpenTelemetry-backed metrics add normalized CPU, logical processor count, filesystem data, processor-queue load, handles, and pagefile information where configured.

Process dashboards require the OpenTelemetry process scraper and the OAP `hostmetrics-process-monitoring-windows` rules, which produce the `mp_process_windows_*` metrics used at Service Instance scope.

Without the process scraper, host monitoring continues to work, but the **Processes** tab and Top Process panels have no process data.

For OAP-side setup and the supported metrics, see the [Windows monitoring documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-win-monitoring/).
