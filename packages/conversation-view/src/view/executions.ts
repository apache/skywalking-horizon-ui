/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * What an observer around a call to an MCP server saw it do, from the
 * `execution/1` records a call joins to by its tool-use id. A pill on the
 * call's card says how the first observation ended and how long the runtime
 * measured it; the inspector's Execution tab lists every observation. One
 * call can have several, one per observer, and they are listed, never merged.
 *
 * The values sent and returned are not in a record, only their size and
 * digest, so the tab shows those and never the model's input in their place.
 */

import { esc } from '../dom.js';
import type { Step } from '../model.js';
import { fill } from '../strings.js';
import type { AszExecutionValue } from '../types.js';
import type { ViewContext } from './context.js';

/** The pill on a call's card: the first observation's outcome and measured
 *  time, and how many more observations there are. Empty when none joins. */
export function executionPill(ctx: ViewContext, step: Step): string {
  const { s, f, model: m } = ctx;
  const records = m.executionsOf(step.id);
  if (!records.length) return '';
  const first = records[0];
  let text = first.outcome;
  if (first.duration_ms != null) text += ` · ${f.duration(first.duration_ms)}`;
  if (records.length > 1) text += ` · ${fill(s.moreObservations, { n: records.length - 1 })}`;
  return `<button type="button" class="acv-execution-pill${first.outcome === 'returned' ? '' : ' failed'}" data-to-execution="${esc(
    step.id,
  )}" title="${esc(s.executionPillTitle)}">${esc(text)}</button>`;
}

/** The inspector's Execution tab: every observation of the call, in the order the document lists them. */
export function drawExecutionTab(ctx: ViewContext, body: HTMLElement, step: Step): void {
  const { s, f, model: m } = ctx;
  const row = (dt: string, dd: string, mono = false): string => `<dt>${esc(dt)}</dt><dd class="${mono ? 'mono' : ''}">${dd}</dd>`;
  let html = '';
  for (const r of m.executionsOf(step.id)) {
    const ended = Date.parse(r.time);
    html += `<div class="acv-kicker" style="margin-top:14px">${esc(s.observedBy)} <span class="mono">${esc(r.observed_by)} · ${esc(r.boundary)}</span></div>`;
    html += `<dl class="acv-definition">`;
    html += row(s.mcpServer, r.server ? esc(r.server.name) : '—', true);
    if (r.server?.source) html += row(s.configuredIn, esc(r.server.source), true);
    html += row(s.outcomeWord, esc(r.outcome), true);
    html += row(
      s.measuredTime,
      r.duration_ms != null ? esc(f.duration(r.duration_ms)) : `<span class="acv-faint">${esc(s.notReported)}</span>`,
    );
    html += row(s.observedAt, Number.isFinite(ended) ? esc(f.dateTime(ended)) : esc(r.time));
    if (r.arguments) html += row(s.sentToServer, value(ctx, r.arguments), true);
    if (r.result) html += row(s.cameBack, value(ctx, r.result), true);
    html += row(
      s.readFrom,
      `seq ${r.ref.seq} · row ${r.ref.row}${r.ref.block != null ? ` · block ${r.ref.block}` : ''} <button type="button" class="acv-linkish" data-to-evidence data-ref-seq="${r.ref.seq}" data-ref-row="${r.ref.row}" data-ref-block="${r.ref.block ?? ''}">${esc(s.openEvidence)}</button>`,
      true,
    );
    html += `</dl>`;
  }
  html += `<div class="acv-warning"><strong>${esc(s.measuredTime)}</strong><br>${esc(s.measuredTimeText)}</div>`;
  body.innerHTML = html;
  body.querySelectorAll<HTMLElement>('[data-to-evidence]').forEach(
    (b) =>
      (b.onclick = () => {
        const block = b.dataset.refBlock;
        ctx.state.rawRef = { seq: Number(b.dataset.refSeq), row: Number(b.dataset.refRow), ...(block ? { block: Number(block) } : {}) };
        ctx.showTab('evidence');
      }),
  );
}

/** A value's size and digest; the value itself is never in the record. */
function value(ctx: ViewContext, v: AszExecutionValue): string {
  const { s, f } = ctx;
  return esc(fill(s.sizeAndDigest, { bytes: f.number(v.bytes), digest: v.sha256 ? v.sha256.slice(0, 12) : '—' }));
}
