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

# AI Agents

The **AI_AGENT** layer is where the [SkyWalking AI Sessionizer](https://skywalking.apache.org/docs/skywalking-ai-sessionizer/next/readme/) lands the conversations of long-lived AI agents, and where the agent's own metrics land beside them. The Sessionizer collects an agent's transcripts on the machine where the agent runs, assembles them into conversations, and pushes them to OAP; OAP stores them under this layer and answers Horizon's reads. Nothing in Horizon talks to the agent or to the Sessionizer directly.

In Horizon's sidebar this layer is named **AI Agents**. Its top-level entities are **Agents** (the service slot): one per kind of agent, `Claude Code` for the Claude Code adapter, or whatever service name the Sessionizer was configured with. Each agent reports through one or more **Agent runtimes** (the instance slot): one Sessionizer process on one machine, named `user@host` by default, or the mailbox or machine name its operator set.

The layer has three tabs: **Agents** (the service dashboard), **Agent runtimes** (the instance dashboard) and **Conversations**. See [AI Agent Conversations](../operate/ai-agent-conversations.md) for the Conversations tab. This page is the operator reference for the two metric dashboards: what you see on each and what each widget means.

> The layer appears only when OAP reports it, which needs OAP 11.1.0 or later with at least one conversation or metric pushed. The OAP side — receiving, verifying and storing the files, the metric rules, and retention — is documented with the other [OAP backend setup pages](https://github.com/apache/skywalking/tree/master/docs/en/setup/backend) in the SkyWalking repository.

> The widgets and metrics below are read from the bundled AI_AGENT template; if an operator has published a customized template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Where the metrics come from

The metric family is Claude Code's own: the same names its OpenTelemetry exporter uses. Two agent runtimes can produce it, and a deployment picks one arrangement per agent:

- **The Sessionizer derives the token metric from the transcripts it lands** (the `metrics` switch on its Claude Code adapter). This gives tokens by type, by model and by source, and nothing else: cost, active time, sessions, lines of code, commits, pull requests and edit decisions are not in a transcript, and the Sessionizer never estimates them.

- **Claude Code's own exporter sends the full family**, either to the Sessionizer's OpenTelemetry receiver adapter, which relays every request to OAP under the agent's identity, or straight to OAP with the resource attributes `service.layer=AI_AGENT` and a `service.instance.id` naming the agent runtime. To land under the same agent as the conversations, give the exporter the same `service.name`; its default is `claude-code`.

Never combine the first arrangement with an exporter that sends straight to OAP for the same sessions: every token would be counted twice, and OAP cannot tell the two sources apart, whatever the agent runtime names. The Sessionizer refuses a configuration where it both derives and relays, for the same reason.

## Agents list

Before opening a agent, the layer landing page lists every agent with two sortable columns, sorted by **Tokens** by default. The values describe one completed hour, named beside them:

- **Tokens** — tokens of every type in that hour (`meter_ai_agent_tokens`).

- **Cache read share** — the percentage of what the model read that came from cache (`meter_ai_agent_cache_read_share`).

## Agent dashboard

The primary drill-down for one selected agent. Four widgets are always shown; seven more appear only when Claude Code's own exporter reports, because a Sessionizer-only deployment never has those metrics and a permanently empty widget would read as broken.

**Tokens, from either agent runtime**

- **Tokens by type** — one line per token type: `input`, `output`, `cacheRead`, `cacheCreation` (`meter_ai_agent_tokens_by_type`). Cache reads are most of the total, so the types are separate lines rather than a stack.

- **Main agent and subagents** — tokens by where the call was made: `main`, `subagent`, and `auxiliary` from the exporter only (`meter_ai_agent_tokens_by_source`).

- **Tokens by model** — one line per model the calls ran on (`meter_ai_agent_tokens_by_model`).

- **Cache read share** — `cacheRead` over every type except `output`, in percent (`meter_ai_agent_cache_read_share`).

**From Claude Code's exporter only**

- **Cost by model** — in USD (`meter_ai_agent_cost_by_model`).

- **Active time** — seconds of `user` (keyboard) and `cli` (tool execution and responses) activity (`meter_ai_agent_active_time`).

- **Sessions started** (`meter_ai_agent_sessions`).

- **Lines of code** — `added` and `removed` by the editing tools (`meter_ai_agent_lines_of_code`).

- **Commits** (`meter_ai_agent_commits`) and **Pull requests** (`meter_ai_agent_pull_requests`), each shown only when its own metric reports.

- **Edit permission decisions** — `accept` and `reject` on the editing tools (`meter_ai_agent_edit_decisions`).

## Agent runtime dashboard

The same eleven widgets for one selected agent runtime, over the per-agent runtime metrics (`meter_ai_agent_instance_*`), with the same rule for the exporter-only ones.

## Reading the numbers

- **A point is the total of its bucket, counted at the minute a call ended.** The step follows the time range: minutes up to four hours, hours up to fourteen days, days beyond. A long call's tokens land in the one minute it finished. A push that carries a whole session's minutes, as the Sessionizer's does, is analysed a minute at a time, so history pushed after the fact draws where it happened, not when it arrived.

- **The Sessionizer's metrics are a subset.** Tokens by type, model and source are there; the other seven metrics come only from Claude Code's exporter, and nothing is estimated in their place. A agent runtime that derives sees `main` and `subagent` as sources; `auxiliary`, the agent's own side calls, never reaches a transcript.

- **The cache read share is a ratio formed per received batch, then averaged.** It is not the ratio of the window's token totals: a agent runtime that pushes many small requests weighs more than one that pushes few large ones, and an hour of the share is the average of its minutes, while an hour of tokens is the sum of its minutes.

- **Cache reads dominate.** On one five-day conversation they were 98% of all tokens. That is why the type widget draws separate lines and why the share is worth its own widget.

- **Derived series never overlap in time.** When a subagent's file lands later than its parent's, its tokens may be placed after the series' last point rather than at the minute they happened. The conversation document itself always knows a session's tokens exactly, on its model-call steps.

## Upgrading

Horizon seeds a bundled template into OAP only when OAP holds no template of that name, and never rewrites a stored one. An OAP that already holds an earlier AI Agents template, one with the Conversations tab only, keeps it after an upgrade. To adopt the metric dashboards, open **Dashboard setup → Layer dashboards → AI Agents**, choose **Reset to → Bundled**, review **Check diff & push**, and re-apply any customisation the diff shows, such as renamed slots, before pushing.

## Bundled template

The bundled AI_AGENT template enables the service and instance dashboards and the `aiConversations` component, names the two entity slots as above, and carries the widgets listed here. Like every layer template it can be edited under **Dashboard setup → Layer dashboards** and published to OAP; see [Layer Dashboard Templates](../customization/layer-templates.md).
