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
# Alarms

Path: `/alarms`. The page is read-only and needs no special permission to view.

The Alarms page is the triage surface for everything OAP's alerting engine is firing right now, across every layer. It pulls the alarms OAP recorded over a recent window, groups the repeat firings of a rule on the same entity into a single incident, lays them out on a per-layer timeline, and shows the trigger expression and the captured metric snapshot for whichever alarm you select.

Alarms are **read-only here by design**. OAP recovers an alarm automatically once the condition clears — there is no acknowledge, close, or silence action in the UI, and there is nothing to dismiss. A firing alarm stops firing when the underlying metric stops crossing the threshold; the page reflects that state, it does not drive it.

## The time window

The window picker offers three presets — `20m`, `2h`, `4h` — plus a custom range capped at 4 hours.

Alarms are second-precision events, and a long window pulls thousands of rows that some storage backends struggle to return; the 4-hour ceiling is enforced both in the picker and on the server, so a custom range wider than 4 hours is rejected. If the response is clipped, the timeline header shows a "page may be truncated — tighten the window" note: narrow the window to see a complete slice.

The window's starting preset can be set per deployment — see [Alert page setup](#admin-setup-pinned-layers-and-default-window) below.

## Active count and per-layer breakdown

The KPI strip at the top counts what is **actively firing**, not the raw event count.

- **Active** — the total number of incidents that are currently firing. A fully recovered incident contributes nothing here, so this number answers "what is on fire right now?" rather than "what happened recently?".
- **Per-layer tiles** — one tile per pinned layer (for example `General`, `Mesh`), each showing that layer's active count. Pinned layers always render, even at zero, so the strip is stable across refreshes.
- **Other** — a read-only aggregate of active alarms in layers you did not pin, plus any alarm OAP could not attribute to a known layer. The arithmetic `Active = (sum of pinned tiles) + Other` always holds, so nothing hides off-screen.
- **Overflow chips** — below the tiles, the non-pinned layers that actually have an active alarm appear as small pills, sorted by count, as a filter shortcut.

Clicking a tile, a chip, or a list tab narrows the timeline and the list to that layer; the selection is reflected in the URL, so a refresh or a shared link preserves it. Click the active tile again (or the **Active** tile) to clear the filter.

## Filtering

Above the timeline is a filter row. What it offers depends on the connected OAP version:

- On a current OAP, you get a cascading **Layer → Service → Instance → Endpoint** picker plus a free-text **Keyword** match on the alarm message. These filters are applied at the source, so the page only fetches the alarms that match.
- On an older OAP that does not support entity-scoped alarm queries, the row collapses to **Keyword** only, with a note inviting an upgrade for the full layer and entity filters.

The filter is a draft until you press **apply** — nothing refires while you are composing it. **clear** resets every field.

## Timeline

The timeline plots each alarm as a flag on a per-layer lane, so you can see at a glance when a burst happened and which layers it touched. It keeps every individual firing and recovery — not the merged incident — so a fire-then-recover pattern stays visible.

Two interactions:

- **Click a flag** to select that alarm and load its detail on the right.
- **Brush a region** to slice the list (and the counts) to that sub-window. The brushed rectangle is the only marker for the selection; the timeline itself still shows the full window so you can see other peaks to re-brush onto.

**reset** clears the brushed range and the selected alarm.

## Incidents and the list

OAP emits one alarm record per firing, so a rule that re-fires after its silence period produces several records. The list collapses the repeat firings of one rule on one entity into a single **incident** row, tagged with how many times it triggered. Each row carries a state:

- **firing** — currently firing, and it never recovered within the window.
- **unstable** — currently firing, but it recovered at least once earlier in the window and fired again (a flapping rule). The badge shows how many of its firings are currently active versus recovered. Unstable still counts as active.
- **recovered** — the latest firing has cleared. Recovered incidents stay in the list as recent history but drop out of the Active count and the per-layer tiles — recovered is "no alarm".

For an incident that triggered more than once, the chevron at the end of the row expands a per-firing history: every individual firing and recovery on that entity and rule, in time order. Clicking a sub-entry loads that specific event into the detail panel. The list pages ten incidents at a time.

## Alarm detail

Selecting an alarm — from a timeline flag, a list row, or an expanded history entry — opens the detail panel on the right:

- **Status** — a `firing` or `recovered` pill, plus when the alarm started and (if cleared) when it recovered, and its layer.
- **Message** — the human-readable alarm text OAP formatted from the rule.
- **Tags** — any tags OAP attached to the alarm.
- **Trigger expression** — the MQE expression the rule evaluated, exactly as it fired.
- **Rule** — when the OAP admin port is reachable, the matched rule's body: `period`, `silence`, `recovery-obs`, notification hooks, and the metrics it references. A "view in catalog" link jumps to the same rule on the [Alerting rules](#alerting-rules-the-running-context) page. When the admin port is unreachable, this section is omitted.
- **Snapshot** — one small chart per metric, plotting the values OAP captured at the firing moment so you can see what actually crossed the threshold. The trigger minute is marked, and the rule's evaluation window is shaded when the rule body is available. An alarm recorded without an MQE snapshot (older OAP, or snapshot capture disabled in the rule) shows a note instead of charts.

## Admin: setup, pinned layers, and default window

Which layers get their own KPI tile, and which window preset the page opens on, are configured on the **Alert page setup** admin page (`/admin/alert-page-setup`, verb `alarm-setup:read`), reachable from the page's intro text.

## Alerting rules: the running context

Path: `/operate/alerting-rules`. Verb: `alarm-rule:read`.

The Alerting rules page is a **read-only** catalog of every alarm rule loaded into the OAP cluster. Rules themselves are authored in OAP's `alarm-settings.yml` and reloaded by OAP's watcher — there is no add, edit, or delete here.

Each rule lists its expression, window settings (`period`, `silence`, `recovery-obs`, and any `additional` period), the metrics it references, hooks, tags, entity include/exclude filters, and a per-node load state (`loaded a/b`) — because in a cluster each OAP instance loads the rule independently, and a partial count flags a node that has not picked it up.

### Per-entity running state

Each OAP instance only evaluates a rule over the slice of entities it holds, so a rule's **Currently watching** list is the union of evaluated entities across all nodes, with each entity tagged by the node watching it. Click an entity to open its live running context. Because the entity may be evaluated on only one node, the popup answers per node: the node actually evaluating it returns a populated body; the others read as "Not evaluated on this instance."

For the evaluating node, the popup shows the rule's current evaluation window (its size, the silence countdown, the recovery-observation countdown, and the window's end time), the last alarm time and message, and a snapshot sparkline of the metric values in the window — each point annotated with its value and bucket time.

The headline of each node block is the rule's **current state** for that entity. The states an operator will see:

| State | Meaning |
|---|---|
| `FIRING` | The rule's condition is currently met for this entity and the alarm is active. This is what surfaces as a firing alarm on the [Alarms](#alarms) page. |
| `SILENCED_FIRING` | The condition is still met, but the alarm is inside its silence period after a recent firing, so OAP is holding off re-notifying. It is firing but quiet — no fresh notification goes out until the silence window elapses. |
| `OBSERVING_RECOVERY` | The condition has stopped being met and OAP is watching to confirm the recovery holds for the rule's recovery-observation period before fully clearing the alarm. A flap back into breach during this window keeps the alarm active. |

These states are the live evaluation context behind the alarms you see on the Alarms page — they let you confirm that a rule is watching the entity you expect, see exactly where it is in the fire / silence / recover cycle, and read the very metric values it is acting on. The running context comes straight off OAP's admin port; when that port is unreachable, the catalog surfaces a banner and the per-entity context is unavailable.

## Related

- [Runtime Rules (DSL)](runtime-rules.md) — runtime-editable MAL / LAL analysis rules that produce the metrics alarm rules evaluate.
- [Metrics Inspect](inspect.md) — browse the metric catalog and find which entities report a given metric.
