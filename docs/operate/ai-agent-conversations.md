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

# AI Agent Conversations

The **Conversations** tab of the [AI Agents](../dashboards/ai_agent.md) layer lists the conversations of long-lived AI agents that the [SkyWalking AI Sessionizer](https://skywalking.apache.org/docs/skywalking-ai-sessionizer/next/readme/) pushed to OAP. A conversation is the Sessionizer's unit of storage: one durable exchange between a person and an agent, however many sessions, context resets and child agents it spanned. This page is about the list; each row stands for one conversation as OAP holds it.

It is not the [AI assistant](ai-assistant.md). The assistant is Horizon's own chat, where Horizon sends text to a model provider on your behalf. This tab reads stored transcripts of other agents and sends nothing anywhere.

## Requirements

- OAP 11.1.0 or later. Older OAPs have no `AI_AGENT` layer, so the layer never appears in the sidebar.
- A running AI Sessionizer configured to push to this OAP. Until it has pushed at least one conversation, the layer has no service and stays hidden.
- The `ai-conversation:read` permission, which the built-in `viewer`, `maintainer` and `operator` roles carry. See [Roles and Permissions](../access-control/rbac.md).

## Reading the list

Pick an **agent runtime** (the layer's service — `Claude Code`, or the name the Sessionizer was configured with), a **time range**, then click **Run query**. The tab owns its own time range, like the Traces and Logs tabs: the global time picker and auto-refresh do not drive it. A conversation is in the window when its last activity is; the presets run from a day to 90 days because a conversation lives for days, not minutes.

Once the rows are in, two filters narrow them without another read: the **sender** filter lists the Sessionizer processes that pushed the rows you see, and the free-text filter matches the title or the conversation id.

| Column | Meaning |
|---|---|
| Title | The session's title as the agent runtime recorded it. A conversation with no title shows *(untitled)*; the conversation id sits under the title in either case. |
| Sender | Which Sessionizer pushed it — one process on one machine, `user@host` unless its operator named it. |
| Talks | Readable exchanges: one input from outside, the agent's run, and its answer. |
| Steps | Everything the agent did: model calls, reasoning, tool uses, messages, agent launches, resets. |
| Streams | Execution streams: the main agent plus one per child agent it started. |
| Segments | Activity windows, split by idle time. |
| Unresolved | References the Sessionizer could not resolve — a tool result it never saw, a child whose stream never arrived. Worth a look when it is not zero. |
| Span | From the conversation's first record to its last activity. |
| Last activity | When the newest record was written, in your browser's time. Rows are ordered by it, newest first. |

The counts come from the conversation's newest round as the Sessionizer wrote it; they are what the Sessionizer itself lists, not something Horizon computed.

### What the list can and cannot show

**The list is built from rounds, not conversations.** The Sessionizer publishes a conversation as a chain of immutable rounds, a new round every few minutes while the agent is active, and OAP builds the list from the newest rounds in the window — up to a fixed budget (10,000 by default), folded to one row per conversation. The line above the table states that budget. A conversation whose newest round is older than every one of those rounds is not listed even though it is stored; narrowing the time range brings it back, and so does asking for a runtime with fewer conversations. OAP has no way to say whether the budget cut anything, so Horizon states the rule rather than guessing.

**Retention is OAP's.** On BanyanDB the conversation files live in their own group with their own lifetime (30 days by default); on other storages they follow the record retention. A conversation older than that is gone from the list because it is gone from OAP.

**One conversation, one row, per sender.** The same conversation pushed by two Sessionizers, or by one that was renamed between pushes, appears once per sender name.

## Troubleshooting

- **The layer is missing from the sidebar.** OAP reports no `AI_AGENT` layer: either it is older than 11.1.0, or nothing has been pushed yet. Check the Sessionizer's push output for its receiver address and errors.
- **The runtime is listed but the query returns nothing.** The window may be too narrow for a conversation's last activity, or every round in the window may belong to other conversations (see above). Try 90 days, and check the sender filter is not set.
- **A conversation you know exists is not there.** Its newest round may lie outside the round budget, or the conversation may be older than OAP's retention. The Sessionizer's own list page shows what it holds locally; compare the two.
