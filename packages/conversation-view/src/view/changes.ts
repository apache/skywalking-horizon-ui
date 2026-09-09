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
 * Which files a tool call changed, drawn in three places from one index:
 * a pill on the tool's card with the details opening inline under it, the
 * inspector's Changes tab with the record's provenance, and a panel over
 * the whole conversation grouped by workspace root and file.
 *
 * A record is shown as its producer wrote it. Two producers can report one
 * call (the runtime's own patch and the asz plugin's observation) with
 * different context lines, and the plugin writes one record per workspace
 * root, so records are grouped by root and listed, never merged. Line
 * counts are per record: two windows on one root each net their own span.
 */

import { cssEscape, esc } from '../dom.js';
import {
  CAPTURED_BY_RUNTIME,
  changeRoots,
  groupChanges,
  incompleteObservation,
  observationOf,
  tallyChanges,
  type Step,
} from '../model.js';
import { fill, type ViewStrings } from '../strings.js';
import type { AszChangeSide, AszFileChange, AszWorkspaceChange } from '../types.js';
import type { ViewContext } from './context.js';

export const ICON_CHANGES = 'acv-i-changes';
export const ICON_READONLY = 'acv-i-readonly';

/** The two marks, defined once and referenced everywhere they appear: a
 *  plus over a minus for a call that changed files, an eye for one the
 *  plugin classed read-only and did not scan. */
export function symbolDefs(): string {
  return `<svg class="acv-defs" aria-hidden="true" focusable="false">
    <symbol id="${ICON_CHANGES}" viewBox="0 0 16 16"><path d="M3 4.5h10M8 1.5v6M3 12h10" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
    <symbol id="${ICON_READONLY}" viewBox="0 0 16 16"><path d="M1.5 8s2.6-4.5 6.5-4.5S14.5 8 14.5 8s-2.6 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/></symbol>
  </svg>`;
}

export function icon(id: string, cls = ''): string {
  return `<svg class="acv-ico${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="#${id}"></use></svg>`;
}

const PREVIEW_LINES = 200;

function fileKey(stepId: string, r: AszWorkspaceChange, c: AszFileChange): string {
  return `${stepId}|${r.captured_by}|${r.id}|${c.path}`;
}

function producer(s: ViewStrings, r: AszWorkspaceChange): string {
  const runtime = r.captured_by === CAPTURED_BY_RUNTIME;
  return `<span class="acv-producer${runtime ? ' runtime' : ''}">${esc(r.captured_by)}</span> <span class="acv-faint">${esc(
    runtime ? s.capturedByRuntime : s.capturedByPlugin,
  )}</span>`;
}

function basisPhrase(s: ViewStrings, r: AszWorkspaceChange): string {
  switch (r.basis) {
    case 'tool_window':
      return s.basisToolWindow;
    case 'runtime_reported':
      return s.basisRuntimeReported;
    case 'skipped_read_only':
      return s.basisSkipped;
    case 'unattributed':
      return s.basisUnattributed;
    default:
      return r.basis;
  }
}

function counts(ctx: ViewContext, add: number | null, del: number | null): string {
  if (add === null || del === null) return '';
  return `<span class="acv-file-counts"><span class="acv-add">+${ctx.f.number(add)}</span> <span class="acv-del">−${ctx.f.number(del)}</span></span>`;
}

function marks(s: ViewStrings, c: AszFileChange): string {
  let html = '';
  if (c.attribution === 'shared') {
    html += `<span class="acv-mini acv-warn" title="${esc(fill(s.sharedWith, { windows: (c.windows ?? []).join(', ') }))}">${esc(s.sharedShort)}</span>`;
  }
  if (c.attribution === 'outside_any_window') html += `<span class="acv-mini acv-warn">${esc(s.outsideWindow)}</span>`;
  return html;
}

function sizes(ctx: ViewContext, c: AszFileChange): string {
  const side = (present: boolean, bytes: number | null): string => (!present ? '∅' : bytes === null ? '?' : `${ctx.f.number(bytes)} B`);
  return `<span class="acv-mini">${side(c.before.present, c.before.bytes)} → ${side(c.after.present, c.after.bytes)}</span>`;
}

/** The hunks of one file as a unified diff: the marker line a runtime patch
 *  ends with is drawn as a marker, and a long diff shows its head until asked
 *  for the rest, since a runtime patch for a large write can run to thousands
 *  of lines. */
function diffHtml(ctx: ViewContext, key: string, c: AszFileChange): string {
  const { s, f, state } = ctx;
  if (c.diff !== 'available') {
    const why = c.diff === 'binary' ? s.diffBinary : c.diff === 'too_large' ? s.diffTooLarge : s.diffUnavailable;
    const sha = (side: AszChangeSide): string =>
      side.sha256 ? `<span title="${esc(side.sha256)}">${esc(side.sha256.slice(0, 12))}…</span>` : '∅';
    return `<div class="acv-diff-note">${esc(why)}<span class="acv-hashes">sha256 ${sha(c.before)} → ${sha(c.after)}</span></div>`;
  }
  const rows: string[] = [];
  for (const h of c.hunks ?? []) {
    rows.push(`<div class="acv-diff-hunk">@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@</div>`);
    for (const line of h.lines) {
      const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('\\') ? 'marker' : 'ctx';
      rows.push(`<div class="acv-diff-line ${cls}">${esc(line)}</div>`);
    }
  }
  const all = state.fullDiffs.has(key) || rows.length <= PREVIEW_LINES;
  const shown = all ? rows : rows.slice(0, PREVIEW_LINES);
  let html = `<pre class="acv-diff">${shown.join('')}</pre>`;
  if (!all) {
    html += `<button type="button" class="acv-linkish acv-diff-more" data-diff-all="${esc(key)}">${esc(fill(s.moreLines, { n: f.number(rows.length - PREVIEW_LINES) }))} · ${esc(s.showAllLines)}</button>`;
  }
  const notes: string[] = [];
  if (c.before.no_newline_at_end) notes.push(s.noNewlineBefore);
  if (c.after.no_newline_at_end) notes.push(s.noNewlineAfter);
  if (notes.length) html += `<div class="acv-diff-note">${notes.map(esc).join(' · ')}</div>`;
  return html;
}

function fileRow(ctx: ViewContext, stepId: string, r: AszWorkspaceChange, c: AszFileChange): string {
  const { s, state } = ctx;
  const key = fileKey(stepId, r, c);
  const open = state.openChangeFiles.has(key);
  return `<div class="acv-change-file${open ? ' open' : ''}">
    <button type="button" class="acv-change-file-row" data-change-file="${esc(key)}" aria-expanded="${open}">
      <span class="acv-fold-mark">${open ? '▾' : '▸'}</span>
      <span class="acv-op ${esc(c.operation)}">${esc(c.operation)}</span>
      <span class="acv-file-path">${esc(c.path)}</span>
      ${counts(ctx, c.additions, c.deletions)}${marks(s, c)}${sizes(ctx, c)}
    </button>
    ${open ? diffHtml(ctx, key, c) : ''}
  </div>`;
}

/** What a record observed when it lists no file: said in words, because an
 *  empty list means three different things. */
function observationNote(s: ViewStrings, r: AszWorkspaceChange): string {
  switch (observationOf(r)) {
    case 'skipped':
      return `<div class="acv-change-note">${icon(ICON_READONLY)} ${esc(s.basisSkipped)}</div>`;
    case 'unknown':
      return `<div class="acv-change-note">${esc(s.changedFilesUnknown)}</div>`;
    case 'none':
      return `<div class="acv-change-note">${esc(s.changedFilesNone)}</div>`;
    default:
      return '';
  }
}

function coverageWarning(s: ViewStrings, r: AszWorkspaceChange): string {
  if (r.coverage !== 'partial') return '';
  return `<div class="acv-warning"><strong>${esc(s.coveragePartial)}</strong><br>${(r.gaps ?? []).map(esc).join('<br>') || '—'}</div>`;
}

function recordBlock(ctx: ViewContext, stepId: string, r: AszWorkspaceChange, meta: boolean): string {
  const { s } = ctx;
  let html = `<div class="acv-change-record">
    <div class="acv-change-record-head">${producer(s, r)}${r.tool_name ? ` <span class="acv-mini">· ${esc(r.tool_name)}</span>` : ''}</div>`;
  if (meta) html += recordMeta(ctx, r);
  html += coverageWarning(s, r);
  html += observationNote(s, r);
  for (const c of r.changes ?? []) html += fileRow(ctx, stepId, r, c);
  html += `</div>`;
  return html;
}

function recordMeta(ctx: ViewContext, r: AszWorkspaceChange): string {
  const { s, f } = ctx;
  const row = (dt: string, dd: string, mono = false): string => `<dt>${esc(dt)}</dt><dd class="${mono ? 'mono' : ''}">${dd}</dd>`;
  const at = (iso: string): string => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? esc(f.dateTime(ms)) : esc(iso);
  };
  let html = `<dl class="acv-definition acv-change-meta">`;
  html += row(s.basisWord, `<span class="mono">${esc(r.basis)}</span> <span class="acv-faint">· ${esc(basisPhrase(s, r))}</span>`);
  html += row(s.observedAt, at(r.time));
  if (r.outcome) {
    html += row(
      s.outcomeWord,
      `${esc(r.outcome.state)}${r.outcome.exit_code !== null ? ` <span class="acv-faint">· ${esc(fill(s.exitCode, { code: r.outcome.exit_code }))}</span>` : ''}`,
    );
  }
  if (r.window) {
    html += row(s.scannedBefore, `${at(r.window.before.from)} – ${at(r.window.before.to)}`);
    html += row(s.scannedAfter, `${at(r.window.after.from)} – ${at(r.window.after.to)}`);
  }
  if (r.policy) {
    html += row(s.policyWord, [r.policy.exclusions, r.policy.read_only].filter(Boolean).map(esc).join(' · ') || '—', true);
  }
  const runtime = r.captured_by === CAPTURED_BY_RUNTIME;
  html += row(
    s.readFrom,
    `seq ${r.ref.seq} · row ${r.ref.row}${r.ref.block != null ? ` · block ${r.ref.block}` : ''} <span class="acv-faint">· ${esc(
      runtime ? s.onResultRecord : s.inChangesFile,
    )}</span> <button type="button" class="acv-linkish" data-to-evidence data-ref-seq="${r.ref.seq}" data-ref-row="${r.ref.row}" data-ref-block="${r.ref.block ?? ''}">${esc(s.openEvidence)}</button>`,
    true,
  );
  html += `</dl>`;
  if (r.overlaps?.length) {
    html += `<div class="acv-change-note">${esc(s.overlapsNote)} ${r.overlaps
      .map((o) => esc(`${o.tool_name ?? o.tool ?? o.capture} · ${o.stream} · ${o.state}`))
      .join('; ')}</div>`;
  }
  return html;
}

/** The pill on a tool card: the eye for a call classed read-only, the
 *  plus-minus for one that changed files (or whose count is unknown or
 *  zero), with the unique file count and, when one record covers the step,
 *  its line counts. Empty when no record joins to the step. */
export function changePill(ctx: ViewContext, step: Step): string {
  const { s, f, model: m, state } = ctx;
  const records = m.changesOf(step.id);
  if (!records.length) return '';
  const t = tallyChanges(records);
  const open = state.openChanges.has(step.id);
  const skipped = t.observation === 'skipped';
  const title = skipped ? s.readOnlyCallTitle : open ? s.hideChanges : s.showChanges;
  const common = `type="button" data-changes-toggle="${esc(step.id)}" aria-expanded="${open}" title="${esc(title)}"`;
  if (skipped) {
    return `<button ${common} class="acv-change-pill readonly">${icon(ICON_READONLY)} ${esc(s.readOnlyCall)}</button>`;
  }
  let text: string;
  let cls = '';
  if (t.observation === 'unknown') {
    text = s.filesUnknown;
    cls = ' unknown';
  } else if (t.observation === 'none') {
    text = s.noFilesChanged;
    cls = ' none';
  } else {
    // A plus says the count is a floor: a scan stopped early or a record carries no count.
    text = t.files === 1 && !t.incomplete ? s.oneFileChanged : fill(s.filesChanged, { n: `${f.number(t.files)}${t.incomplete ? '+' : ''}` });
  }
  return `<button ${common} class="acv-change-pill${cls}">${icon(ICON_CHANGES)} ${esc(text)}${
    t.observation === 'files' ? counts(ctx, t.additions, t.deletions) : ''
  }</button>`;
}

/** The details under a card whose pill is open: every record of the step,
 *  by root, the runtime's first in each. Laid out only while open. */
export function inlineChanges(ctx: ViewContext, step: Step): string {
  const { s, model: m, state } = ctx;
  if (!state.openChanges.has(step.id)) return '';
  const records = m.changesOf(step.id);
  if (!records.length) return '';
  const groups = groupChanges(records);
  let html = `<div class="acv-changes-inline">`;
  for (const g of groups) {
    if (groups.length > 1) html += `<div class="acv-change-root">${esc(s.workspaceRoot)} <span class="mono">${esc(g.root || '—')}</span></div>`;
    const ordered = [g.preferred, ...g.records.filter((r) => r !== g.preferred)];
    for (const r of ordered) html += recordBlock(ctx, step.id, r, false);
  }
  html += `<button type="button" class="acv-linkish acv-changes-more" data-to-changes="${esc(step.id)}">${esc(s.moreInChangesTab)}</button></div>`;
  return html;
}

/** The inspector's Changes tab: the same records with their provenance. */
export function drawChangesTab(ctx: ViewContext, body: HTMLElement, step: Step): void {
  const { s, model: m } = ctx;
  const records = m.changesOf(step.id);
  const groups = groupChanges(records);
  let html = '';
  for (const g of groups) {
    html += `<div class="acv-change-root">${esc(s.workspaceRoot)} <span class="mono">${esc(g.root || '—')}</span></div>`;
    const ordered = [g.preferred, ...g.records.filter((r) => r !== g.preferred)];
    for (const r of ordered) html += recordBlock(ctx, step.id, r, true);
  }
  body.innerHTML = html;
  bindChangeControls(ctx, body, redrawBoth(ctx));
  body.querySelectorAll<HTMLElement>('[data-to-evidence]').forEach(
    (b) =>
      (b.onclick = () => {
        const block = b.dataset.refBlock;
        ctx.state.rawRef = { seq: Number(b.dataset.refSeq), row: Number(b.dataset.refRow), ...(block ? { block: Number(block) } : {}) };
        ctx.showTab('evidence');
      }),
  );
}

/** The card and the tab share the open-file state, so a toggle on either
 *  redraws both; the control that was activated gets its focus back. */
export function redrawBoth(ctx: ViewContext): (focusSelector?: string) => void {
  return (focusSelector) => {
    ctx.drawTranscript();
    ctx.drawInspector();
    if (focusSelector) ctx.root.querySelector<HTMLElement>(focusSelector)?.focus();
  };
}

/** The conversation-level panel: every file by root, with the records that
 *  saw it and the step each belongs to; then what no observed window made. */
export function drawChangesPanel(ctx: ViewContext): void {
  const { s, f, model: m } = ctx;
  const body = ctx.q('.acv-changes-body');
  const all = m.workspaceChanges;
  const files = new Set<string>();
  for (const r of all) for (const c of r.changes ?? []) files.add(`${r.root?.path ?? ''}|${c.path}`);
  const floor = all.some(incompleteObservation) ? '+' : '';
  ctx.q('.acv-changes-title').textContent = `${s.changesPanelTitle} · ${fill(s.recordsAndFiles, { records: f.number(all.length), files: `${f.number(files.size)}${floor}` })}`;
  // What a tool made is listed under its root whether or not the fold knew
  // the step; only a record the plugin itself could not attribute goes below.
  const attributed = all
    .filter((r) => r.basis !== 'unattributed')
    .map((r) => ({ ...r, changes: (r.changes ?? []).filter((c) => c.attribution !== 'outside_any_window') }));
  const entry = (r: AszWorkspaceChange, c: AszFileChange): string => {
    const step = m.step(r.step);
    const when = Number.isFinite(Date.parse(r.time)) ? f.time(Date.parse(r.time)) : r.time;
    // A record whose step the fold does not know still names its tool; the
    // missing step is said, not implied by a label that cannot be clicked.
    const who = step ? (step.name ?? step.kind) : [r.tool_name, s.noStepForRecord].filter(Boolean).join(' · ');
    const label = `${who} · ${r.captured_by} · ${when}`;
    const target = step
      ? `<button type="button" class="acv-linkish" data-goto="${esc(step.id)}" title="${esc(s.goToStep)}">${esc(label)} →</button>`
      : `<span class="acv-faint">${esc(label)}</span>`;
    return `<div class="acv-panel-entry">${target} ${counts(ctx, c.additions, c.deletions)}${marks(s, c)}</div>`;
  };
  let html = attributed.some((r) => m.step(r.step)) ? `<div class="acv-panel-hint">${esc(s.changesPanelHint)}</div>` : '';
  for (const root of changeRoots(attributed)) {
    html += `<div class="acv-change-root">${esc(s.workspaceRoot)} <span class="mono">${esc(root.root || '—')}</span></div>`;
    for (const fl of root.files) {
      const op = fl.entries[fl.entries.length - 1]!.change.operation;
      html += `<div class="acv-panel-file"><div class="acv-panel-file-head"><span class="acv-op ${esc(op)}">${esc(op)}</span><span class="acv-file-path">${esc(fl.path)}</span></div>${fl.entries
        .map((e) => entry(e.record, e.change))
        .join('')}</div>`;
    }
  }
  const outside: Array<{ record: AszWorkspaceChange; change: AszFileChange }> = [];
  for (const r of all) {
    for (const c of r.changes ?? []) {
      if (r.basis === 'unattributed' || c.attribution === 'outside_any_window') outside.push({ record: r, change: c });
    }
  }
  if (outside.length) {
    html += `<div class="acv-change-root acv-warn">${esc(s.outsideWindowsHeading)}</div><div class="acv-loose-note">${esc(s.outsideWindowsNote)}</div>`;
    for (const e of outside) {
      html += `<div class="acv-panel-file"><div class="acv-panel-file-head"><span class="acv-op ${esc(e.change.operation)}">${esc(e.change.operation)}</span><span class="acv-file-path">${esc(
        e.record.root?.path ? `${e.record.root.path}/` : '',
      )}${esc(e.change.path)}</span></div>${entry(e.record, e.change)}</div>`;
    }
  }
  body.innerHTML = html || `<div class="acv-empty">—</div>`;
  body.querySelectorAll<HTMLElement>('[data-goto]').forEach(
    (b) =>
      (b.onclick = () => {
        ctx.select(b.dataset.goto!, true);
        ctx.showTab('changes');
        ctx.q('.acv-changes-close').dispatchEvent(new Event('click'));
      }),
  );
}

/** The toggles a record's file rows and long diffs share between the card
 *  and the tab; `redraw` is whichever surface holds them. */
export function bindChangeControls(ctx: ViewContext, root: HTMLElement, redraw: (focusSelector?: string) => void): void {
  root.querySelectorAll<HTMLElement>('[data-change-file]').forEach(
    (b) =>
      (b.onclick = (ev) => {
        ev.stopPropagation();
        const key = b.dataset.changeFile!;
        if (ctx.state.openChangeFiles.has(key)) ctx.state.openChangeFiles.delete(key);
        else ctx.state.openChangeFiles.add(key);
        redraw(`.acv-inspector-body [data-change-file="${cssEscape(key)}"]`);
      }),
  );
  root.querySelectorAll<HTMLElement>('[data-diff-all]').forEach(
    (b) =>
      (b.onclick = (ev) => {
        ev.stopPropagation();
        ctx.state.fullDiffs.add(b.dataset.diffAll!);
        redraw(`.acv-inspector-body [data-change-file="${cssEscape(b.dataset.diffAll!)}"]`);
      }),
  );
}
