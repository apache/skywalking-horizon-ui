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

The **OS_LINUX** layer monitors Linux hosts from host telemetry collected by SkyWalking OAP. Hosts are represented as **Hosts** at the Service scope, while process groups collected by the OpenTelemetry process scraper are represented as **Processes** at the Service Instance scope.

In Horizon's sidebar this layer lives under the **OS** group and is named **Linux**. The layer is metrics-only: it exposes **Hosts** and **Processes**, but no endpoint, topology, traces, or logs tabs.

This page is the **operator reference** for the bundled Linux dashboards: what is shown at the host and process scopes, and which telemetry is required.

> The widgets and metrics below are read from the bundled OS_LINUX template; if an operator has published a customized OS_LINUX template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Host list

Before opening a host, the layer landing page lists every Linux host with four sortable columns, sorted by **CPU total %** by default:

* **CPU total %** — host CPU utilization (`meter_vm_cpu_total_percentage`).
* **Memory MB** — memory in use, in MB (`meter_vm_memory_used/1024/1024`).
* **Load 1m** — the 1-minute load average (`meter_vm_cpu_load1/100`).
* **FS %** — filesystem space used, as a percent (`meter_vm_filesystem_percentage`).

## Host dashboard

The Host dashboard combines metrics available from the existing VM monitoring sources with additional metrics available from OpenTelemetry hostmetrics.

The summary cards include:

* **CPU Across Cores** — current host CPU utilization from the configured host telemetry source.
* **Memory Used** — current physical memory in use.
* **Load 1m** — current 1-minute system load.
* **Swap Used** — current swap utilization.
* **Normalized CPU** — host CPU utilization normalized to the conventional 0–100% scale when the OpenTelemetry hostmetrics metric is available.
* **Logical CPUs** — logical processor count reported by OpenTelemetry hostmetrics.

The historical charts include:

* **CPU by State** — CPU utilization by reported CPU state.
* **CPU Load** — 1m / 5m / 15m load averages.
* **Normalized CPU** — normalized host CPU utilization when available.
* **File FD Allocated** — allocated file descriptors when available.
* **Memory RAM (MB)** — used / total / available / buff-cache physical memory.
* **Memory Swap (MB)** — free vs total swap.
* **Network Bandwidth (KB/s)** — receive vs transmit throughput.
* **Disk R/W (KB/s)** — disk read vs written throughput.
* **Filesystem Usage (%)** — filesystem space utilization.
* **TCP Connections** — established and time-wait TCP connections.
* **Linux Socket Counters** — additional socket counters when supported by the configured telemetry source.

Widgets whose backing metrics are unavailable are hidden automatically.

## Top Processes

When the OpenTelemetry process scraper is enabled, the Host dashboard also shows three Top Process panels:

* **Top Processes by CPU** — process groups ranked by total, user, or system CPU.
* **Top Processes by Memory** — process groups ranked by resident memory or host-memory percentage.
* **Top Processes by Resources** — process groups ranked by threads, open file descriptors, or grouped process count.

These panels are hidden when process metrics are not available.

## Processes dashboard

The **Processes** page represents normalized process groups reported as Service Instances.

For a selected process group Horizon shows current values for:

* CPU utilization;
* resident physical memory;
* percentage of host memory;
* grouped process count;
* threads;
* open file descriptors;
* oldest process uptime.

Historical charts show CPU, resident memory, host-memory percentage, process and thread counts, open file descriptors, and oldest-process uptime.

The **Processes** tab is part of the bundled OS_LINUX layer. If the OpenTelemetry process scraper is not running, the tab has no process entities to display.

## Requirements

The Host dashboard consumes the `meter_vm_*` metrics produced by the OAP Linux VM monitoring rules.

For OpenTelemetry hostmetrics, configure the Collector to send Linux host metrics through the `vm-monitoring` job. These metrics add normalized CPU, logical CPU count, and the other hostmetrics-backed widgets while remaining compatible with the existing host monitoring metrics.

Process dashboards require the OpenTelemetry process scraper and the OAP `hostmetrics-process-monitoring-linux` rules, which produce the `mp_process_linux_*` metrics used at Service Instance scope.

Without the process scraper, host monitoring continues to work, but the **Processes** tab and Top Process panels have no process data.

For OAP-side setup and the supported metrics, see the [VM monitoring documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-vm-monitoring/).
