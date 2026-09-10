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

# GenAI Evaluation Records

OAP can score LLM calls with an LLM judge: each call a GenAI span records is sent to a judge model with the evaluation tasks you configured, and every verdict is stored as an **evaluation record** tied to the provider, the model, the calling service and the exact span that was judged. Horizon shows these records on the **Virtual GenAI** layer's **Evaluation records** tab, one row per judged call and task.

The calls can come from either trace source. A service on a SkyWalking agent reports GenAI spans natively; a service on OpenTelemetry reports them over OTLP, which OAP stores as Zipkin spans. Both are judged, and both kinds of record open the trace they came from.

## Requirements

- OAP's AI evaluation module must be enabled and pointed at a judge, with the tasks to score defined. This is OAP configuration, not Horizon's; see the SkyWalking documentation on LLM-as-Judge for the judge settings and the sampling rate. With sampling below every call, a quiet system can go a while between records.

- Reading the tab needs the `logs:read` permission. The trace link on a row and **Pick span…** need `traces:read` as well; the span address can still be typed without it. The provider picker on this tab reads the evaluation catalog rather than the metrics roster, so a role with only `logs:read` can still pick a provider.

- The layer template must enable the tab. The bundled `VIRTUAL_GENAI` template does; see [Layer templates](../customization/layer-templates.md) for the component switches.

## Reading the list

Each row is one judged call for one task, newest first by default:

- **Time** and **Date** — when the judge answered.

- **Service** — the calling service, as its own agent or SDK reports its name.

- **Provider / model** — the provider the call went to and the model that answered, as OAP resolved them from the span.

- **Operation** — the GenAI operation on the span, for example `chat`.

- **Judge model** — the model that scored the call.

- **Task** — the evaluation task the verdict belongs to.

- **Level** — the level OAP mapped the verdict to: fail, warning, good or excellent, with a left-edge colour to match. A verdict outside the configured ranges shows as undefined.

- **Trace** — opens the trace the call was judged from; see below.

- **Value** — the verdict itself, prefixed with its type: a score, a true/false, a string or a JSON value.

Click a row for the full record. A score or a true/false verdict leads the table of the record's fields; a string or JSON verdict is shown as a document beside that table. The judge's reason and the identifiers of the judged span are in the table, and the trace button in the popout opens the same trace as the row's link.

Above the list, the **Evaluation Levels** strip shows each level's share of the newest records in the window, up to a sample of a few hundred; the record count behind a share is in its tooltip. The bar under it shows how the loaded page spreads over time. Click a level to keep only that level; click it again to clear. Unlike the conditions, a level click applies at once.

## Conditions

Conditions are staged as you edit them and applied when you press **Run query**, as on the Logs and Traces tabs. Opening the tab reads nothing until then; a switch of provider clears the list back to the prompt.

- **Provider** — the provider whose records to read. The tab opens on the layer's first provider; the picker filters as you type.

- **Model** — one of the provider's models, or all of them. A model that has gone quiet but is named in a shared link stays selectable.

- **Value** — the verdict type, and beside it the operand that type takes: a minimum and maximum for a score, true or false for a boolean verdict. String and JSON verdicts take no operand. Leave the type at **Any type** to see every task.

- **Task name** — one evaluation task, typed exactly as it is configured on OAP.

- **Service** — the calling service. The picker lists the services OAP knows across layers, plus, once a query has run, any caller seen in the records that has no catalog entry of its own. A service that reports only over OTLP is the usual case of the latter.

- **Judge model** — records scored by one judge.

- **Sort by** — newest first, or by score in either direction when the value type is Score.

- **Trace ID** — records judged from one trace. Pick the addressing scheme beside it: **SkyWalking Native** for a trace from a SkyWalking agent, **OTLP** for one from OpenTelemetry. The condition can then narrow to one span of that trace, which is how a call with several LLM spans is told apart:

  - **Pick span…** opens the trace and lists its spans, with the ones the judge samples marked **LLM** and shown first. **Use** on a span fills the address; **Use whole trace** clears it.

  - The address can also be typed: the segment ID and span index for a native trace, or the span ID for an OTLP one. These are the identifiers a record's detail popout shows, and the ones that appear in logs correlated with the call.

- **Time range** — a rolling window, or **Custom** for an absolute one. A window can span up to seven days.

- **Page size** — rows per page. Paging applies at once, without a new Run query.

## Opening the trace

The trace link opens the trace in a popout without leaving the list, with the judged span already selected. A native trace opens on the native waterfall; an OTLP trace opens on the Zipkin renderer. Either way the lookup is bounded to the record's own time, so with the query cold stage on, a record older than the hot window still opens its trace. The popout shares the page's address, so the browser's back button closes it and the URL can be shared.

## From the dashboards

The Virtual GenAI **Models** dashboard has an **Evaluation Score** chart. A point on it drills into this tab with the provider, model, task and hour already applied, and runs the query on arrival.

## Troubleshooting

- **No records, though the provider has traffic.** The judge is not enabled on OAP, or its sampling rate is leaving calls unjudged. Check OAP's AI evaluation configuration; OAP's own log reports a judge that cannot be reached.

- **The provider picker is empty.** No GenAI span has reached OAP yet, so the layer has no provider. The picker fills once one has.

- **A calling service is missing from the Service picker.** A service that reports only over OTLP has no catalog entry. Run a query with the picker at **All services**; the caller then appears in the list under *seen in records*.

- **The trace opens with no spans.** The record is written when the judge answers, and the trace's spans are written on their own cycle; for a call judged seconds ago, try the link again shortly. For an older trace, check the query cold stage and the time range.

## Related

- [Traces](traces.md) — the trace tabs the popouts share their renderers with.

- [Logs](logs.md) — the Logs tab, which this tab follows for its conditions and Run query.

- [Access control](../setup/rbac.md) — the `logs:read` and `traces:read` permissions.
