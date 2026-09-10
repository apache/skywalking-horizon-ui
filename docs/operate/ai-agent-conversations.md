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

The **agent** is the layer's service — `Claude Code`, or the name the Sessionizer was configured with — and it is picked where every layer's service is picked, in the header above the tabs. Pick a **time range**, optionally one **agent runtime** (the Sessionizer processes that pushed to this agent), then click **Run query**. The agent runtime is part of the query: OAP lists only that agent runtime's conversations. The tab owns its own time range, like the Traces and Logs tabs: the global time picker and auto-refresh do not drive it. A conversation is in the window when its last activity is; the presets run from a day to 90 days because a conversation lives for days, not minutes.

Two more conditions travel with the query: **Title contains** keeps the conversations whose title contains the text, matched by OAP on each conversation's newest title, and **Conversation id** asks OAP for that one conversation. Enter in either box runs the query.

| Column | Meaning |
|---|---|
| Title | The session's title as the agent recorded it. A conversation with no title shows *(untitled)*; the conversation id sits under the title in either case. |
| Agent runtime | Which Sessionizer pushed it — one process on one machine, `user@host` unless its operator named it. |
| Talks | Readable exchanges: one input from outside, the agent's run, and its answer. |
| Model calls | Calls the agent made to its model provider. |
| Subagents | Child agents the conversation started, each its own stream. |
| Bash runs | Shell commands run through the runtime's Bash tool. |
| Changes | How many change records the Sessionizer captured for the conversation as of its newest round. A record is one observation: a tool call the plugin watched, per configured workspace root, so one call over two roots is two; the agent's own patch of an edit, so a call two producers both recorded is two; a scan that found nothing, or a shell command the plugin classed read-only and skipped, counts as one; and changes seen between two calls that no call made count too. The plus-over-minus mark sits beside a count above zero, with the lines those records' diffs added and removed, summed over the records, so an edit two records both cover is counted in both. A dash in this or the three columns before it means the round did not carry the count: the Sessionizer that pushed it predates it. |
| Unresolved | References the Sessionizer could not resolve — a tool result it never saw, a child whose stream never arrived. Worth a look when it is not zero. |
| Span | From the conversation's first record to its last activity. |
| Last activity | When the newest record was written, in your browser's time. Rows are ordered by it, newest first. |

The counts come from the conversation's newest round as the Sessionizer wrote it; they are what the Sessionizer itself lists, not something Horizon computed.

### What the list can and cannot show

**The list is built from rounds, not conversations.** The Sessionizer publishes a conversation as a chain of immutable rounds, a new round every few minutes while the agent is active, and OAP builds the list from the newest rounds in the window — up to a fixed budget (10,000 by default), folded to one row per conversation. The line above the table states that budget. A conversation whose newest round is older than every one of those rounds is not listed even though it is stored; narrowing the time range brings it back, and so does asking for a runtime with fewer conversations. OAP has no way to say whether the budget cut anything, so Horizon states the rule rather than guessing.

**Retention is OAP's.** On BanyanDB the conversation files live in their own group with their own lifetime (30 days by default); on other storages they follow the record retention. A conversation older than that is gone from the list because it is gone from OAP.

**One conversation, one row, per agent runtime.** The same conversation pushed by two Sessionizers, or by one that was renamed between pushes, appears once per agent runtime name.

## Reading a conversation

Click a row, or press Enter on it, and the conversation opens in a **new browser tab** of its own. The page reads the whole conversation from OAP in one document and shows the wait as it happens: first *OAP is assembling the conversation* with the seconds counting, because OAP folds the whole chain before it sends a byte; then the bytes coming in as *n of m MB received* with a percentage, the rate and the time left, and the talk, step and stream counts; then the parse and the draw. A conversation of a thousand talks and fifty thousand steps is tens of megabytes and draws in well under a second once the document has arrived.

The page's address is the thing to share. It carries the conversation, its agent and agent runtime, and the reader's position — the talk, the selected step and the stream being read — and it is updated in place as you move, so copying the address bar hands a colleague the same step. Opening it needs a Horizon sign-in and the `ai-conversation:read` permission; a signed-out reader is sent to the login page and back.

The page has three parts, and a header with the conversation's title, agent, agent runtime and id, a link back to the list, the theme chip and the language picker (the page follows your Horizon theme, the light one included, and every text of it is translated):

- **Transcript** — the talks of one execution stream in reading order. What came from outside sits on the right; the agent's replies sit on the left; the work between an input and its reply (model calls, reasoning, tool uses, agent launches, context resets) is folded under a *show what the agent did* row so a long run reads as a conversation until you open it. Long pauses are marked. A tool call's input and result are drawn as the fields the runtime recorded rather than as one escaped string: a shell command as the lines that were run, a file edit as its path and the text before and after, a result's output and error streams apart. A long text is cut short with a *show all* link that opens it in place, and where the document clipped the text a note says how much of it is there. Every field carries a *copy* button, and an edit's `old_string` and `new_string` are drawn as one diff, removed lines red and added lines green, the way git shows them. Steps the Sessionizer could not place under any talk are listed in their own *Outside any talk* section rather than dropped.
- **Flow timeline** — the same stream on a time axis, one lane per kind of activity (external input, responses, context put in, model calls, tools, agent activity, runtime notices, nested streams). Busy stretches take the width; a long pause is cut to a marked gap. Selecting a step draws the relations that touch it: a solid line is an exact join, a dashed one was inferred, a faint curve is ownership (the model call that produced a step). A child agent appears as a nested stream you can select, then **dive into**; the header offers the way back to the step that opened it. `j` and `k` move through the steps, `Enter` dives in, `Escape` clears the selection.
- **Inspector** — the selected step's **Details**, opening with where the step sits in words a reader knows (the activity window and its place among them, the agent, the talk by its opening line, the run's place in it, and the step by kind and name; the document's own ids sit in the tooltip), then its kind, lane, stream, segment, run, parent, time, token counts, request-to-result interval where the runtime recorded it, and its input and result drawn as fields the way the transcript draws them), its **Relations** (what it opened, what opened it, what it joined with and how well), its **Evidence**: the landed positions of the record the step came from and the text as the document carries it, with a note when the document clipped it, and, for a tool call that has them, its **Changes** (below). The ⤢ button in the inspector's header pops it out into a panel over the whole page, four fifths of it each way, for a long command or diff; ⤡, `Escape` or a click outside the panel docks it again. A field's *copy* button sits beside its name, and a result that is one text has one on its *result* line.

### Changes

When the Sessionizer recorded which files a tool call changed, the call's card in the transcript wears a mark beside the tool name. A plus-over-minus mark reads `2 files · +3 −1`: how many files the call changed and, when one record covers the call, the lines added and removed. An eye mark reads *read-only*: the asz Claude Code plugin classed the shell command as read-only and did not scan around it, so nothing is known about files. That is not "no changes"; a call whose observation found nothing says *no files changed*, and one whose count the record does not carry says *files unknown*. The same mark sits on the step's clip in the flow timeline.

Clicking the mark opens the changes under the card without moving the selection: one row per file with its operation (`create`, `modify`, `delete`, `type_change`), its path relative to the workspace root, its line counts and sizes, and a row opens to the diff, drawn as a unified diff with added and removed lines coloured. A file changed by two tools whose windows overlapped is marked *shared* and names the other window. A binary file, or one too large to diff, shows its path and hashes and says why there is no diff. A long diff shows its first two hundred lines until you ask for the rest.

Two producers can record one call, and the page keeps their records apart rather than merging them. Claude Code itself records the patch for its own `Edit`, `Write` and `NotebookEdit` calls on the main stream (`claude-code`, *the runtime's own patch*). The asz Claude Code plugin records shell commands by scanning the workspace before and after the call, and the editing tools inside a subagent from the patch the tool reported (`asz-plugin`). When both recorded a call, the runtime's record is shown first and the plugin's beneath it, each with its own line counts; when the plugin was configured with several workspace roots, one shell command has one record per root, listed by root. The **Changes** tab in the inspector adds each record's provenance: its basis, the scans it ran between, the command's outcome and exit code, the exclusion and read-only policy sets it ran under, a warning with the gaps when a scan stopped early, the other windows open on the same root, and the landed position it was read from, with a link to the Evidence tab. The policy sets and what the plugin observes are described in the Sessionizer's [Claude Code plugin](https://skywalking.apache.org/docs/skywalking-ai-sessionizer/next/en/setup/claude-code-plugin/) page.

The status strip counts the change records of the whole conversation; the count opens a panel listing every changed file by workspace root, with each record that saw it as a link that opens the step it belongs to, on its Changes tab. Files changed between two observed calls by something no hook covered, a person, an editor or an unhooked tool, are listed at the end under *Changes outside observed tool windows*, since no step made them.

The status strip at the top states the document's integrity — *verified* when every round's digest chained, *incomplete* when rounds are missing, *mismatch* when a digest did not match — and lists the problems the Sessionizer recorded when it is not verified. The **Overview** button opens the summary cells and a filterable list of every talk in the conversation.

What the page shows is exactly what the Sessionizer's own viewer shows for the same conversation: the two draw the same document with the same renderer. The words the runtime uses for things — node kinds such as `message.external`, relation types, join qualities — are shown as the document carries them, in every locale.

### Limits

- **One document, all at once.** OAP sends the whole conversation, and its `viewTimeoutMs` budget (120 s by default, see [Configuration File](../setup/horizon-yaml.md)) covers the wait for the first byte. A conversation OAP cannot assemble within that time reports a timeout; try again, or raise the budget on both sides. Horizon holds the document before the browser starts receiving it, which is how the page knows the size to count against; that hold is a fifth of the document's size per conversation being opened.
- **Records are not on OAP.** The Sessionizer's own viewer can open the raw landed record behind a step; OAP stores the assembled document only, so this page shows the text the document carries and says when it was clipped.

## Troubleshooting

- **The layer is missing from the sidebar.** OAP reports no `AI_AGENT` layer: either it is older than 11.1.0, or nothing has been pushed yet. Check the Sessionizer's push output for its receiver address and errors.
- **The agent is listed but the query returns nothing.** The window may be too narrow for a conversation's last activity, or every round in the window may belong to other conversations (see above). Try 90 days, and check the agent runtime filter is not set.
- **A conversation you know exists is not there.** Its newest round may lie outside the round budget, or the conversation may be older than OAP's retention. The Sessionizer's own list page shows what it holds locally; compare the two.
- **The conversation page says OAP holds no round for this agent.** The link names a agent OAP has no round of this conversation for — the Sessionizer was renamed between pushes, or the agent runtime in the link is not the one that pushed it. Open the conversation from the list again.
- **The page waits a long time, then reports a timeout.** OAP assembles the whole chain before answering, and a very long conversation can exceed the time budget. Try again; if it keeps happening, raise `performance.aiConversation.viewTimeoutMs` in Horizon and the matching `viewRequestTimeout` on OAP.
- **A row does nothing when clicked.** The browser blocked the new tab as a pop-up. Allow pop-ups for Horizon's address, or open the row with Enter after focusing it.
- **No tool call shows a change mark.** Change records exist from AI Sessionizer 0.3.0 with an OAP that carries them in the document. The runtime's own `Edit` and `Write` patches need no plugin, but a session collected by an earlier Sessionizer has none, since the record is made when the transcript is collected, not when it is re-read. Shell commands and edits inside subagents are recorded only where the asz Claude Code plugin is installed.
