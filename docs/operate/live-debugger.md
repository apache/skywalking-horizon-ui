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

# Live Debugger

Path: `/operate/live-debug`.

The Live Debugger captures, step by step, how a single analysis rule processes real data inside the connected OAP — so you can see *why* a metric comes out the way it does (or why it comes out empty) without reading the backend logs. You pick one rule, start a capture session, and OAP records each pipeline stage (input → filter → function → output) for a bounded number of executions. The capture runs on **every reachable OAP node at once**, so a rule that behaves differently on one node in a cluster is visible side by side. When you are done, you stop the session; captures are also saved locally so you can re-open them later.

This is a diagnostic surface for the same DSL families you edit on the [Runtime Rules (DSL)](runtime-rules.md) page — it does not change any rule. Starting a session never alters collection; it attaches a recorder to the rule for the length of the session and detaches when you stop it or the retention window lapses.

## The three DSL tabs

The page is split into three tabs, one per DSL family. Each tab runs its own independent session, so you can have a MAL, a LAL, and an OAL capture going at the same time.

| Tab | DSL family | What it debugs |
|---|---|---|
| **MAL** | Meter Analysis Language | `otel-rules`, `log-mal-rules`, `telegraf-rules` — the meter pipeline for OTEL, log-derived, and Telegraf metrics. |
| **LAL** | Log Analysis Language | `lal` — log parsing and extraction, capturable at **block** or **statement** granularity. |
| **OAL** | Observability Analysis Language | the connected OAP's OAL clauses — input source columns through aggregation and output. |

OAL rules are not runtime-editable (they are compiled into the OAP build), but they are still debuggable here — this is the one place you can watch an OAL clause execute against live source data.

## Running a capture

1. **Pick a rule.** For MAL, choose a rule file and then a specific metric inside it; for LAL choose the log rule (and block / statement granularity); for OAL choose the source and clause.
2. **Set the bounds.** `recordCap` limits how many executions are captured (default and maximum **100**). `retention (min)` is how long the session stays alive on OAP before it is reaped (default **5** minutes, maximum **60**).
3. **Start.** OAP installs the recorder across the cluster and begins collecting. The state pill moves through `starting → capturing → captured`. While capturing, the view refreshes about once a second; it stops polling on its own once every reachable node has finished (`captured`).
4. **Stop** at any time to detach the recorder early. You do not have to wait for the retention window.

Starting a new session for a rule that already has one running automatically replaces the prior session — the coverage strip notes how many prior sessions were stopped.

### Cluster coverage strip

Above the captured records, a per-node strip shows, for each OAP node, an **install** result (whether the recorder was accepted on that node) and a **collect** status (whether data came back). A rollup line summarizes how many nodes the session is live on (e.g. *live on 2 of 3 nodes*). Use it to spot a node that rejected the install or was unreachable — a missing node there explains a partial capture.

## Reading the captured stages

Each captured execution is shown as a chain of stages. Every stage reports an `in → out` count, so a stage that drops everything (a filter that matched nothing) is obvious at a glance. Clicking a stage highlights the matching fragment of the rule's source text above the chain, tying the captured step back to the line of DSL that produced it.

### Diff-default label grouping

When a stage emits many samples that share a metric name, they are grouped under a one-line summary rather than listed in full. Expanding a multi-sample group lands in **diff mode** by default: the labels that are identical across every sample collapse into a shared context shown once, and each sample row shows only the labels that *differ*. This makes "what distinguishes these series" the thing you see first. A toggle switches to the full per-sample label list when you want every label on every row. The same diff-first treatment applies to a run of output entities that share a metric — only the entity fields that vary are shown per row.

Very large groups render a capped number of detail rows with a "+ N more" note; the summary count is always exact.

## The LAL pipeline matrix

A LAL capture renders as a grid — one column per captured record, one row per pipeline step (input, the per-statement or per-block function steps, output). The first column names each step and stays pinned as you scroll sideways through the records; each cell holds that record's data at that step.

**It reads any log format.** A cell shows whatever fields OAP serialized for the record — a plain `LogData` input shows service / endpoint / tags / body, while an Envoy access-log (ALS) record shows its built snapshot (service, endpoint, response data, and the access-log content as JSON). When OAP cannot serialize a record's raw input, the cell shows the reason (for example `jsonformat-failed …`) instead of rendering blank, and a small label names each cell's payload class.

**Filter a row to the records that have data.** A step row that has gaps carries a filter; turning it on narrows the grid to just the records that produced data for that step — for example the output row to only the records that emitted output (an abnormal-only rule aborts most records, so only a few reach output). The row count shows how many of all captured records reached that step.

**Inspect and diff a cell.** Each cell has a button — `VIEW` on the input row, `DIFF` on the builder rows — that opens the cell's complete payload in a JSON viewer with the log content shown as formatted JSON. For the built-log snapshots you can compare stages: a picker presents the captured rule with each per-statement step on its line and the extractor / sink blocks as selectable ranges, and choosing one shows a side-by-side diff of the two snapshots — the quickest way to see which statement or stage added, changed, or dropped a field.

Each OAP node renders its own matrix; filtering or selecting in one node's grid does not affect another's.

## Capture history

Every session you run is saved to **capture history**, browse it at `/operate/live-debug/history` (or the *history* link on each tab). History is stored locally in your browser — it is not shared between users or machines and survives reloads, with the most recent captures kept per DSL family.

From history you can:

- **Replay** a finished capture — re-open the recorded stages exactly as they were captured, without re-running anything on OAP. A banner marks that you are viewing a saved capture, with a *back to live* control to return.
- **Resume** a capture whose retention window has not yet lapsed — re-attach to the still-live OAP session and continue polling it.

A capture that was archived before its first poll returned data shows as having no records; run a longer-lived capture to give the pipeline time to fire.

## Requirements

- The OAP `dsl-debugging` module must be loaded. This is the module that powers start / poll / stop across MAL / LAL / OAL; the page shows a warning banner when it is missing. See [Required OAP Modules](../compatibility/required-modules.md).
- The `receiver-runtime-rule` module must also be loaded — it backs the rule picker (the catalog of rules you choose from). It is a **separate** module from `dsl-debugging`: a deployment can have one without the other, in which case either the picker or the capture itself will be unavailable.
- OAP admin port reachable from Horizon.

## Access control

| Permission | Grants |
|---|---|
| `live-debug:read` | View the Live Debugger, the active-session list, cluster status, and capture history. |
| `live-debug:write` | Start and stop capture sessions. |
| `rule:debug` | Debug a rule — required alongside `live-debug:write` to actually run a capture. |

In the bundled roles, all three are held by **operator** (and **admin**). A read-only viewer can be granted `live-debug:read` to inspect existing sessions and history without being able to start new captures. See [Roles and Permissions](../access-control/rbac.md).
