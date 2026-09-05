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

## Reading a conversation

Click a row, or press Enter on it, and the conversation opens in a **new browser tab** of its own. The page reads the whole conversation from OAP in one document and shows the bytes as they arrive; OAP assembles the chain before it sends the first byte, so a long conversation is quiet for a few seconds first. A conversation of a thousand talks and fifty thousand steps is tens of megabytes and opens in well under a second once the document has arrived.

The page's address is the thing to share. It carries the conversation, its agent runtime and sender, and the reader's position — the talk, the selected step and the stream being read — and it is updated in place as you move, so copying the address bar hands a colleague the same step. Opening it needs a Horizon sign-in and the `ai-conversation:read` permission; a signed-out reader is sent to the login page and back.

The page has three parts, and a header with the conversation's title, runtime, sender and id, a link back to the list, and the theme chip (the page follows your Horizon theme, the light one included):

- **Transcript** — the talks of one execution stream in reading order. What came from outside sits on the right; the agent's replies sit on the left; the work between an input and its reply (model calls, reasoning, tool uses, agent launches, context resets) is folded under a *show what the agent did* row so a long run reads as a conversation until you open it. Long pauses are marked. Steps the Sessionizer could not place under any talk are listed in their own *Outside any talk* section rather than dropped.
- **Flow timeline** — the same stream on a time axis, one lane per kind of activity (external input, responses, context put in, model calls, tools, agent activity, runtime notices, nested streams). Busy stretches take the width; a long pause is cut to a marked gap. Selecting a step draws the relations that touch it: a solid line is an exact join, a dashed one was inferred, a faint curve is ownership (the model call that produced a step). A child agent appears as a nested stream you can select, then **dive into**; the header offers the way back to the step that opened it. `j` and `k` move through the steps, `Enter` dives in, `Escape` clears the selection.
- **Inspector** — the selected step's **Details** (kind, lane, stream, segment, run, parent, time, token counts, request-to-result interval where the runtime recorded it), its **Relations** (what it opened, what opened it, what it joined with and how well), and its **Evidence**: the landed positions of the record the step came from and the text as the document carries it, with a note when the document clipped it.

The status strip at the top states the document's integrity — *verified* when every round's digest chained, *incomplete* when rounds are missing, *mismatch* when a digest did not match — and lists the problems the Sessionizer recorded when it is not verified. The **Overview** button opens the summary cells and a filterable list of every talk in the conversation.

What the page shows is exactly what the Sessionizer's own viewer shows for the same conversation: the two draw the same document with the same renderer. The words the runtime uses for things — node kinds such as `message.external`, relation types, join qualities — are shown as the document carries them, in every locale.

### Limits

- **One document, all at once.** OAP sends the whole conversation, and its `viewTimeoutMs` budget (120 s by default, see [Configuration File](../setup/horizon-yaml.md)) covers the wait for the first byte. A conversation OAP cannot assemble within that time reports a timeout; try again, or raise the budget on both sides.
- **Records are not on OAP.** The Sessionizer's own viewer can open the raw landed record behind a step; OAP stores the assembled document only, so this page shows the text the document carries and says when it was clipped.

## Troubleshooting

- **The layer is missing from the sidebar.** OAP reports no `AI_AGENT` layer: either it is older than 11.1.0, or nothing has been pushed yet. Check the Sessionizer's push output for its receiver address and errors.
- **The runtime is listed but the query returns nothing.** The window may be too narrow for a conversation's last activity, or every round in the window may belong to other conversations (see above). Try 90 days, and check the sender filter is not set.
- **A conversation you know exists is not there.** Its newest round may lie outside the round budget, or the conversation may be older than OAP's retention. The Sessionizer's own list page shows what it holds locally; compare the two.
- **The conversation page says OAP holds no round for this runtime.** The link names a runtime OAP has no round of this conversation for — the Sessionizer was renamed between pushes, or the sender in the link is not the one that pushed it. Open the conversation from the list again.
- **The page waits a long time, then reports a timeout.** OAP assembles the whole chain before answering, and a very long conversation can exceed the time budget. Try again; if it keeps happening, raise `performance.aiConversation.viewTimeoutMs` in Horizon and the matching `viewRequestTimeout` on OAP.
- **A row does nothing when clicked.** The browser blocked the new tab as a pop-up. Allow pop-ups for Horizon's address, or open the row with Enter after focusing it.
