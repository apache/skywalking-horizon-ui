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
# AI Agent Overview

The **AI Agent Overview** is the usage pane for the AI agents reporting to your OAP — the Claude Code sessions the [SkyWalking AI Sessionizer](https://skywalking.apache.org/docs/skywalking-ai-sessionizer/next/readme/) lands, or any agent pushing its own metrics under the `AI_AGENT` layer. It answers "what did the last month look like day by day and the last ten days hour by hour, how many agents are reporting, how many tokens did they use, and how much of that was cache reads" without opening a agent. The per-agent history over time lives on the layer's own dashboards; see [AI Agents](ai_agent.md).

It draws from the AI_AGENT layer only. Like every overview it sits at the top of the sidebar, above the per-layer entries, and appears only while that layer is reporting (refreshed on the same ~60-second cadence as the menu).

> The widgets and metrics below are read from the bundled overview template; if an administrator has published a customized copy to OAP, the live page reflects that copy instead. These are editable defaults — reshape them in the **Overview Templates** admin page on a bundled-default → local-draft → **Check diff & push** flow. See [Overview Templates](../customization/overview-templates.md) for the editor and the stored format, and [Overview Widgets](../components/overview-widgets.md) for the widget vocabulary.

## Usage

- **Hourly tokens** — a calendar heatmap of the last **10 days** by the hour: one row per day, one column per hour of the OAP's clock, the busiest agents summed, so a working day reads as a band of busy hours and a quiet night as a gap. The grid fits its card: the cells stretch to the width available, and a card too narrow for twenty-four columns turns the grid, days across and hours down. The window rolls and ends at the current hour, so it usually spans eleven calendar rows with the first and last partial. A window of up to 14 days is drawn this way; the editor's **Resolution** control can force hours or days.
- **Daily tokens** — a calendar heatmap of the last **30 days**, one cell per day, the busiest agents summed. Neither grid follows the time picker: the window is fixed by the template (7 to 93 days, changed per widget in the admin editor), so it reads the same whatever range the rest of the page is on. Days are the OAP server's calendar days; today's cell is the day in progress and is outlined to say so. The five shades are cut at the quantiles of the days that saw traffic, so one exceptionally heavy day does not flatten the rest into the faintest shade. Hovering a cell shows its date and value, and clicking one keeps it picked and reads its date and value out in the footer beside the window total, *Total, last 30 days: 74.2M tokens*. A cell wide enough shows its day number, and a wider one its value. The editor can add a line comparing the total to the text of a well-known book; the bundled page leaves it off.

## Agents

- **Agents** — a KPI tile with the layer's agent **count** and seven figures over the time range picked at the top of the page, the twenty busiest agents summed: **Tokens** (`meter_ai_agent_tokens`), **Input**, **Output**, **Cache read** and **Cache created** tokens (`meter_ai_agent_tokens_by_type`, one `type` each), **Subagent tokens** (`meter_ai_agent_tokens_by_source`, the `subagent` source summed over its types), and **Cache read share** (`meter_ai_agent_cache_read_share`, in percent, their average). The token figures are range totals; a layer with more than twenty agents counts them all but sums the twenty busiest.
- **Top 20 agents** — the twenty agents with the most tokens over the picked range, busiest first, each with its token total and a bar against the top one, in as many columns as the card's height needs (two of ten at the bundled height). While the layer has twenty agents or fewer the rows add up to the tile beside it; on a larger layer the card says how many of the agents it lists.

## Where the numbers come from

The page carries only the metrics every source of AI-agent metrics produces — tokens and the cache read share — because an overview widget that has no value reads as broken rather than as absent. The exporter-only families (cost, sessions, active time, lines of code, commits, tool decisions) exist only when the agent's own OpenTelemetry exporter is the source, so they stay on the layer's Service and Instance dashboards, where a widget can hide itself when its metric is missing. See [AI Agents](ai_agent.md) for the arrangements that produce these metrics and the one to avoid.

Each figure aggregates the layer's agents ranked on that metric: the **Agents** tile and **Top 20 agents** across the twenty agents that rank highest over the picked range, and each grid across the eight agents that rank highest over its window. A deployment with more than eight agents reporting to one OAP therefore sees the busiest eight in a grid, and the grid's footer says so.

## Requirements

An overview is a pure consumer of what OAP reports — it invents no data, and a tile with no backing metric reads `—`. To populate the AI Agent Overview, OAP needs:

- **The `AI_AGENT` layer reporting**, which needs OAP 11.1.0 or later with the AI-agent metric rules enabled and at least one agent pushing metrics — through the AI Sessionizer or straight from the agent's exporter.
- **Service-scope token metrics** — `meter_ai_agent_tokens` and `meter_ai_agent_cache_read_share`, the two the page reads. A agent that pushes conversations but no metrics still counts towards the agent count and contributes nothing to the figures; a layer where no agent pushes metrics shows `—` for both.

When the layer is not reporting at all, the overview drops out of the sidebar rather than showing an empty page.
