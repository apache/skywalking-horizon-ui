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
# Airflow

The **AIRFLOW** layer monitors [Apache Airflow](https://airflow.apache.org/) workflow schedulers. OAP collects Airflow's OpenTelemetry metrics and presents each monitored Airflow deployment as a cluster, so this layer is where you watch scheduler health, DAG parsing, executor and pool capacity, and triggerer activity.

In Horizon's sidebar this layer is named **Airflow**, grouped under **Workflow Scheduler**. Its services are listed as **Airflow clusters** and the components that report into each cluster (the scheduler and triggerer processes) are listed as **Components**. The AIRFLOW layer enables only the **Service** and **Instance** scopes — there is no endpoint scope, no topology, and no traces or logs tab, because Airflow's telemetry is scheduler-level meter data rather than request traffic.

This page is the **operator reference** for the bundled AIRFLOW dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled AIRFLOW template; if an operator has published a customized AIRFLOW template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a cluster, the layer landing page lists every Airflow cluster with four sortable columns, sorted by **DAG Bag Size** by default:

- **DAG Bag Size** — number of DAGs found in the last scheduler scan (`meter_airflow_dagbag_size`).

- **DAG Total Parse Time** — seconds spent scanning and importing the queued DAG files (`meter_airflow_dag_total_parse_time`).

- **Executor Open Slots** — free executor slots available to run tasks (`meter_airflow_executor_open_slots`).

- **Scheduled Slots** — pool slots scheduled but not yet running, summed across pools (`aggregate_labels(meter_airflow_pool_scheduled_slots, sum)`).

## Service dashboard

The primary drill-down for one selected Airflow cluster. It opens with four single-value cards reporting the current scheduler and executor state, then a set of time-series charts tracking executor capacity and DAG-processing health.

**Cards (current value)**

- **Tasks Executable** — tasks ready for execution across the cluster (`latest(meter_airflow_scheduler_tasks_executable)`).

- **Running Tasks** — tasks currently running on the executor (`latest(meter_airflow_executor_running_tasks)`).

- **Scheduled Slots** — pool slots scheduled but not yet running, aggregated across pools (`latest(aggregate_labels(meter_airflow_pool_scheduled_slots, sum))`).

- **Queued Tasks** — tasks waiting on the executor (`latest(meter_airflow_executor_queued_tasks)`).

**Charts (over time)**

- **Executor Open Slots** — free executor slots over the window (`meter_airflow_executor_open_slots`).

- **DAG File Queue Size** — DAG files pending a scan (`meter_airflow_dag_file_queue_size`).

- **DAG Import Errors** — DAG files that failed to parse (`meter_airflow_dag_import_errors`).

- **DAG Bag Size** — DAGs found in the last scheduler scan (`meter_airflow_dagbag_size`).

- **DAG Total Parse Time** — seconds to scan and import the queued DAG files (`meter_airflow_dag_total_parse_time`).

- **DAG File Refresh Errors** — DAG file load failures per minute (`meter_airflow_dag_file_refresh_error`).

- **Asset Updates** — asset update events per minute (`meter_airflow_asset_updates`).

## Instance dashboard

For one selected **Component** of the cluster. Airflow reports different meters from different processes — the scheduler emits pool, executor, and asset metrics, while the triggerer emits trigger metrics — so each widget appears only when that component actually reports the metric behind it. A scheduler component therefore shows the pool / executor / heartbeat widgets, a triggerer component shows the triggerer widgets, and neither is shown empty for a component that does not emit it.

**Scheduler component**

- **Pool Open / Deferred / Running Slots** — pool capacity on the scheduler, plotted as three series: open, deferred, and running slots (`meter_airflow_instance_pool_open_slots`, `meter_airflow_instance_pool_deferred_slots`, `meter_airflow_instance_pool_running_slots`).

- **Running Tasks / Scheduled Slots** — executor running-task count against pool slots waiting to run (`meter_airflow_instance_executor_running_tasks`, `meter_airflow_instance_pool_scheduled_slots`).

- **Scheduler Heartbeat** — scheduler heartbeats per minute (`meter_airflow_instance_scheduler_heartbeat`).

- **Executor Open / Queued Slots** — executor capacity and queue depth on the scheduler (`meter_airflow_instance_executor_open_slots`, `meter_airflow_instance_executor_queued_tasks`).

- **Asset Updates** — asset update events on the scheduler, per minute (`meter_airflow_instance_asset_updates`).

- **Asset Triggered DagRuns** — DagRuns triggered by asset events on the scheduler, per minute (`meter_airflow_instance_asset_triggered_dagruns`).

**Triggerer component**

- **Triggerer Heartbeat** — triggerer process heartbeats per minute (`meter_airflow_instance_triggerer_heartbeat`).

- **Triggers Running / Capacity Left** — live deferrable-trigger load on the triggerer: triggers running against capacity left (`meter_airflow_instance_triggers_running`, `meter_airflow_instance_triggerer_capacity_left`).

- **Triggers Blocked / Failed / Succeeded** — deferred-trigger outcomes on the triggerer host, per minute (`meter_airflow_instance_triggers_blocked_main_thread`, `meter_airflow_instance_triggers_failed`, `meter_airflow_instance_triggers_succeeded`).

## Requirements

The AIRFLOW dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs:

- **Cluster (service-scope) Airflow meters** — the `meter_airflow_*` family (DAG bag size and parse time, DAG-processing queue and import / refresh errors, executor open / queued slots and running / executable tasks, pool scheduled slots, asset updates), aggregated per Airflow cluster.

- **Component (instance-scope) Airflow meters** — the `meter_airflow_instance_*` family (per-component pool, executor, scheduler-heartbeat, asset, and triggerer metrics), reported by each scheduler or triggerer process.

These meters are produced by OAP from Airflow's OpenTelemetry metric export — see [Airflow monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-airflow-monitoring/) for how to wire Airflow up to OAP. Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so an instance-scope component metric is empty until that component reports it. When a component does not emit a family — a triggerer that reports no scheduler pool metrics, or a scheduler that reports no triggerer metrics — those widgets are hidden rather than shown empty.
