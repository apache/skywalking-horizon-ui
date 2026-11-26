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

## The DSL tabs

The page is split into four tabs, one per DSL family. Each tab runs its own independent session, so you can have a MAL, a LAL, an OAL and a TAL capture going at the same time.

| Tab | DSL family | What it debugs |
|---|---|---|
| **MAL** | Meter Analysis Language | `otel-rules`, `log-mal-rules`, `telegraf-rules`, `meter-analyzer-config` — the meter pipeline for OTEL, log-derived, Telegraf, and agent-reported metrics. |
| **LAL** | Log Analysis Language | `lal` — log parsing and extraction, capturable at **block** or **statement** granularity. |
| **OAL** | Observability Analysis Language | the connected OAP's OAL clauses — input source columns through aggregation and output. |
| **TAL** | Trace Analysis Language | the connected OAP's TAL rules — how a rule runs on each span of a SkyWalking native segment, or on each OTLP span. Needs SkyWalking 11.2 or later. |

OAL and TAL rules are not runtime-editable (OAP loads them at boot), but they are still debuggable here — this is the one place you can watch an OAL clause or a TAL rule execute against live data.

## Running a capture

1. **Pick a rule.** For MAL, choose a rule file and then a specific metric inside it; for LAL choose the log rule (and block / statement granularity); for OAL choose the source and clause; for TAL choose a rule file and one of its rules (and block / statement granularity, block by default, as OAP's). The ▶ beside a rule on the [TAL rules](runtime-rules.md) page opens this tab with the rule picked.
2. **Set the bounds.** `recordCap` limits how many executions are captured (default and maximum **100**). `retention (min)` is how long the session stays alive on OAP before it is reaped (default **5** minutes, maximum **60**).
3. **Start.** OAP installs the recorder across the cluster and begins collecting. The state pill moves through `starting → capturing → captured`. While capturing, the view refreshes about once a second; it stops polling on its own once every reachable node has finished (`captured`). Against SkyWalking 11.2 or later each refresh reads only the records captured since the previous one and adds them to the list, reading again at once while new records keep coming; against an earlier OAP each refresh reads the whole capture.
4. **Stop** at any time to detach the recorder early. You do not have to wait for the retention window.

Starting a new session for a rule that already has one running automatically replaces the prior session — the coverage strip notes how many prior sessions were stopped.

### Cluster coverage strip

Above the captured records, a per-node strip shows, for each OAP node, its **recorder** (whether the node accepted the session and records the rule: installed, not on this node, rejected, too many sessions, or failed) and its **last read** (how the node answered the latest read: answered, cap reached, no session, or unreachable). A rollup line summarizes how many nodes the session is live on (e.g. *live on 2 of 3 nodes*). Use it to spot a node that rejected the install or was unreachable — a missing node there explains a partial capture. Each node is listed by its address when known, otherwise by its node id; nodes that share a node id, as every OAP binding `0.0.0.0` does by default, are told apart by the instance id each OAP process names itself by (11.2 and later). The capture is read a page at a time, each read picking up where the last one left off; a node that does not answer a read is passed over for it, so the records it captured until then may be missing from the capture once it answers again, though it then reads *answered*. Against an OAP before 11.2, each read is the whole capture: a node that answers replaces its records as a whole, and one that does not answer keeps those read from it before. Behind a load balancer the reads land on different nodes, and the strip gathers what each read said: a node that answered one read and was then reported unreachable by another node can be listed twice, once as *answered* and once as *unreachable*, and a node that leaves the cluster keeps its last state.

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

## The TAL debugger view

The TAL tab needs Apache SkyWalking 11.2 or later; against an older OAP, whose TAL rule listing answers 404, the tab shows a banner saying so. What OAP does with a run's network-alias half after the run, the pairing of the caller and callee halves, has a page of its own: [OTLP Pairing](otlp-pairing.md).

A TAL capture is laid out the way an IDE's debugger shows a paused thread, in three panes under a summary bar. Drag the edge between two panes to resize the side one; the ◧ and ◨ in a side pane's header hide it, leaving a rail that shows it again. The widths and what is hidden are remembered in this browser.

**Export capture** in the summary bar downloads the whole capture, every record of every node as OAP sent it, with the rule and the granularity, as a JSON file: to read it outside the page, or to attach it to a report.

**The summary bar** names the granularity the capture was started with — **block capture**, the blocks each run entered and what it sent out, or **statement capture**, which adds every statement, its variables and every `if` with its operands — and counts what the session captured: the records, and for a native rule the segments, the spans they carry and how many of those the rule ran on; for an OTLP rule the spans; the runs that stopped (an `abort {}`, or the rule failing); the outputs by kind (`source`, `metrics`, `pairing`, …); and each OAP node's records against the `recordCap`. A badge names the rule's input: **native · segment → spans** or **OTLP · span by span**.

**Captured spans** (left) lists the captured records as they arrive, oldest first. A native rule's record is one segment, so its spans list under it in the order the agent sent them, each with the rule's run on it; an OTLP rule's record is one span. A run's network-alias half is one of its outputs (`pairing caller sent`); whether the half later met its pair, and the alias that match pushed, is not the rule's run, so the TAL tab does not show it. Each span is marked ✓ when the run reached the end, ⊘ when it stopped, ✕ when the rule failed, and `·` for a span the rule never ran on; `→N` counts what the run sent out.

**Rule file** (middle) shows the selected frame's rule file with the run on it. A line the capture holds data for has its number in bold and is selectable: it ends with a box of what it produced, pinned to the pane's right edge when the line is wider than the pane — an `if` with its operands and result (`meta.kind = "SERVER" → false`), a variable's value, `entered` for a block, or `→ metrics otlp_service_cpm` where data left the rule. Click the line or its box to open, under it, every variable of the line with its value and what the line produced, objects opened into their fields; in a statement capture, click an underlined variable to see just its value there, highlighted with every use of its name in the file. The gutter marks the lines where data left the rule (●) and where the run aborted (⊘). Double-click a selectable line to step to it. In a statement capture, a line the run did not reach is dimmed, and the first line of each such region says why at its end: *not run · line 155 was false* when it sits in an `if` that was false (or the `else` of one that was true), *not run · the run stopped at line 40* when the run had aborted before it, and *no run recorded · the run failed after line 40* when it failed after the last line it completed: a statement's step is recorded once the statement is done, so the statement that threw is one of the lines after it. The stepping controls at the top of the pane walk the run: **first step**, **step back**, **step over** and **last step**, with the current step's block and kind, and why the run stopped when it did. Other rules of the file are dimmed, and with statement granularity so are the rule's lines the run did not take. Reading the file needs `rule:read`; without it the pane shows the rule's own DSL. A saved capture of a rule edited or moved since shows the DSL it captured as well, so its line numbers stay the ones the run had.

**Selected span** (right) shows the selected span, one field per line with its value in gray; click a field to open its full value under it, as a line of the rule file opens. The rule file and this pane share one selection: a variable picked in the file opens its field here (`meta.kind` under the span's metadata, `attr("…")` the span's attributes, a name the rule set under its variables), and a field picked here highlights its uses in the file, which stays where it is.

- **Span received** — the span as it arrived, its tags or attributes read as a map, and for OTLP the span's metadata as the receiver read it. A time (an epoch in milliseconds or nanoseconds) reads as the browser's local time, the raw value on hover; a metric output's `value` is what the rule handed the metric's function (`value 1`, or `match ok`'s result).
- **Variables set by the rule** — the names the rule set (`def`, assignment, `segmentDef`, `foreach`) by the current step, each with its latest value; a block capture records none.
- **Sent out by the run** — everything the run sent out, one line each: its kind, what it sent (`metrics otlp_service_cpm`, `source Service`, `pairing callee notSampled`), in gray where a metric lands and its value, and the line that sent it. Click an output to open what it carried under it; its `line N →` button goes to the statement that sent it: the run steps there, and the line opens in the rule file; opening an output's line in the file highlights it here too. Those the run sends after the current step are dimmed.
- **Segment variables after the run** (native) — the segment variables the rule set, which every later run of the rule on the segment reads. For OTLP, two sections show only when the run did what they name: **Identity overwritten for this run** — `service`, `instance`, `endpoint` or `layer` set to a value other than the span's, before → after; the rule overwrites its own copy of the span's metadata, which its metrics, sources and alias use, while the stored span and the other rules keep the span's own — and **Added to the stored span** — the tags the run added, which are stored on the span, and its persist vote.
- **Also read by the rule** — a native rule's segment without its spans and what the analyzer computes once per segment before the rules run (start time, latency, error, sampled, tags, size); an OTLP span's resource and instrumentation scope attributes.
- **Rule definition** — the rule's file, layer, input and line.

A frame opens at its last step, so the whole run shows; stepping back and over walks the run, the execution line follows, and the gray values in the file show the steps up to the current one.

## Capture history

Every session you run is saved to **capture history**, browse it at `/operate/live-debug/history` (or the *history* link on each tab). Capture history is a page of its own: leaving the Live debugger for it, or for any other page, stops reading the captures running on its tabs, so while one runs the page asks first; reloading the page or closing the browser tab, the browser asks. They run on in OAP until their retention ends, and Capture history resumes them. History is stored locally in your browser — it is not shared between users or machines and survives reloads, with the most recent captures kept per DSL family. A running capture is saved as it reads, under the rule and settings it was started with, also while you look at another one. The browser keeps about 5 MB for it: a capture that grows past what fits keeps the last copy of it that fit, and its newer records stay in the open page until it is reloaded.

From history you can:

- **Replay** a finished capture — re-open the recorded stages exactly as they were captured, without re-running anything on OAP. A banner marks that you are viewing a saved capture, with a *back to live* control to return.
- **Resume** a capture whose retention window has not yet lapsed — re-attach to the still-live OAP session and continue polling it.

A capture that was archived before its first poll returned data shows as having no records; run a longer-lived capture to give the pipeline time to fire.

## Requirements

- The OAP `dsl-debugging` module must be loaded. This is the module that powers start / poll / stop across MAL / LAL / OAL / TAL, and lists the TAL rules; the page shows a warning banner when it is missing. See [Required OAP Modules](../compatibility/required-modules.md).
- The TAL tab needs SkyWalking 11.2 or later.
- The `receiver-runtime-rule` module must also be loaded — it backs the rule picker (the catalog of rules you choose from). It is a **separate** module from `dsl-debugging`: a deployment can have one without the other, in which case either the picker or the capture itself will be unavailable.
- OAP admin port reachable from Horizon.

## Access control

| Permission | Grants |
|---|---|
| `live-debug:read` | View the Live Debugger, the active-session list, cluster status, and capture history. Nothing else is required to watch a capture. |
| `live-debug:write` | Start and stop capture sessions. Nothing else is required to run one — no `rule:*` grant takes part, and holding every rule verb without `live-debug:*` gets you nothing here. |

The rule pickers read the rule lists the DSL pages read, which need `rule:read`. Without it, the TAL tab takes the file and rule names typed in, and shows a rule's own DSL instead of its file.

In the bundled roles, both are held by **operator** (and **admin**). A read-only viewer can be granted `live-debug:read` on its own to inspect existing sessions and history without being able to start new captures. See [Roles and Permissions](../access-control/rbac.md).
