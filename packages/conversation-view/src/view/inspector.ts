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
 * The inspector answers "where did this come from": what the step is
 * (Details), what touches it (Relations), and the record it was read from
 * (Evidence). Everything shown is in the document; a host that can read a
 * landed record by address may offer the full record beneath the clipped
 * text, and a host with a glossary gets a "?" beside every name it explains.
 */

import { esc } from '../dom.js';
import type { Step } from '../model.js';
import { fill } from '../strings.js';
import type { AszRef, LandedRecord } from '../types.js';
import { kindTitle } from '../vocabulary.js';
import { streamName, type ViewContext } from './context.js';

function field(dt: string, dd: string, mono = false): string {
  return `<dt>${esc(dt)}</dt><dd class="${mono ? 'mono' : ''}">${dd}</dd>`;
}

export function drawInspector(ctx: ViewContext): void {
  const { s, f, model: m, state } = ctx;
  if (state.folder) {
    drawFolderPanel(ctx);
    return;
  }
  const e = m.step(state.sel);
  const relTab = ctx.q<HTMLButtonElement>('[data-tab="relations"]');
  const hasRels = !!(e && e.edges.length);
  relTab.hidden = !hasRels;
  if (!hasRels && state.tab === 'relations') {
    ctx.showTab('details');
    return;
  }
  const title = ctx.q('.acv-inspector-title');
  const meta = ctx.q('.acv-inspector-meta');
  const body = ctx.q('.acv-inspector-body');
  if (!e) {
    title.textContent = '—';
    meta.textContent = '';
    body.innerHTML = `<div class="acv-empty">${esc(s.selectAStep)}</div>`;
    return;
  }
  title.textContent = e.name ? `${e.kind} · ${e.name}` : kindTitle(e.kind, s);
  meta.textContent = `${e.stream.slice(0, 12)} · ${f.time(e.at)}${e.bytes ? ` · ${f.number(e.bytes)} B` : ''}`;
  if (state.tab === 'details') drawDetails(ctx, body, e);
  else if (state.tab === 'relations') drawRelations(ctx, body, e);
  else void drawEvidence(ctx, body, e);
}

/** What is known about a nested stream, and what opened it. */
function drawFolderPanel(ctx: ViewContext): void {
  const { s, f, model: m, state } = ctx;
  const folder = m.foldersFor(state.stream!).find((x) => x.stream.name === state.folder);
  if (!folder) {
    state.folder = null;
    drawInspector(ctx);
    return;
  }
  const st = folder.stream;
  const opener = folder.from;
  ctx.q('.acv-inspector-title').textContent = st.label || `${s.childStreamSingular} ${st.name.slice(0, 6)}`;
  ctx.q('.acv-inspector-meta').textContent = `${s.nestedStream} · ${f.number(st.steps)} ${s.steps.toLowerCase()} · ${folder.quality}`;
  const many = folder.candidates > 1;
  const own = m.openedBy(st.name);
  const body = ctx.q('.acv-inspector-body');
  body.innerHTML = `
    <div class="acv-path">${esc(s.stream.toLowerCase())} ${esc(st.name)} › ${esc(s.openedFrom.toLowerCase())} ${esc(opener.kind)} · ${esc(state.stream ?? '')}</div>
    <dl class="acv-definition">
      ${field(s.stream, esc(st.name), true)}
      ${field(s.role, esc(st.role))}
      ${field(s.steps, f.number(st.steps))}
      ${field(
        folder.back ? s.reportedHereBy : s.openedBy,
        `<button type="button" class="acv-linkish" data-goto="${esc(opener.id)}">${esc(opener.kind)}${opener.name ? ` · ${esc(opener.name)}` : ''}</button>`,
      )}
      ${folder.back ? field(s.note, `<span class="acv-faint">${esc(s.reportedNote)}</span>`) : ''}
      ${field(s.joinQuality, esc(folder.quality))}
      ${field(s.openedAt, opener.at ? esc(f.time(opener.at)) : esc(s.unavailable))}
      ${field(s.itsAnswer, `<span class="acv-faint">${esc(s.itsAnswerNote)}</span>`)}
      ${field(
        s.opensInTurn,
        own.length
          ? own
              .slice(0, 6)
              .map((x) => `<button type="button" class="acv-linkish" data-dive>${esc(x.label || `${s.childStreamSingular} ${x.name.slice(0, 6)}`)}</button>`)
              .join('<br>') + (own.length > 6 ? `<br><span class="acv-faint">${esc(fill(s.andMore, { n: own.length - 6 }))}</span>` : '')
          : `<span class="acv-faint">${esc(s.opensNothing)}</span>`,
      )}
    </dl>
    ${many ? `<div class="acv-warning"><strong>${esc(fill(s.poolWarning, { n: folder.candidates }))}</strong><br>${esc(s.poolWarningText)}</div>` : ''}
    <div class="acv-dive">
      <button type="button" class="acv-btn primary" data-dive-in>${esc(s.diveIn)}</button>
      <span class="acv-hint">${esc(s.diveHint)}</span>
    </div>`;
  body.querySelector<HTMLElement>('[data-dive-in]')!.onclick = () => ctx.diveIn();
  // Going to a grandchild means entering the child first; its own timeline is
  // where that stream is drawn.
  body.querySelectorAll<HTMLElement>('[data-dive]').forEach((b) => (b.onclick = () => ctx.diveIn()));
  body.querySelector<HTMLElement>('[data-goto]')?.addEventListener('click', (ev) => ctx.select((ev.currentTarget as HTMLElement).dataset.goto!, true));
}

function drawDetails(ctx: ViewContext, body: HTMLElement, e: Step): void {
  const { s, f, model: m, state } = ctx;
  const st = m.streamByName.get(e.stream);
  const seg = state.talk ? m.segmentById.get(state.talk.segment) : undefined;
  const path = [`${m.doc.conversation.slice(0, 8)}`];
  if (seg) path.push(`${s.segment.toLowerCase()} ${seg.id.replace(/^segment\//, '')}`);
  path.push(`${s.stream.toLowerCase()} ${e.stream.slice(0, 10)}`);
  if (e.talk) path.push(`${s.talk.toLowerCase()} ${e.talk.replace(/^talk\//, '').slice(0, 14)}`);
  if (e.run) path.push(`${s.run.toLowerCase()} ${e.run.replace(/^run\//, '').slice(0, 14)}`);
  path.push(`${e.kind} ${e.id.slice(0, 20)}`);

  let html = `<div class="acv-path">${path.map(esc).join(' › ')}</div><dl class="acv-definition">`;
  html += field(s.nodeKind, esc(e.kind));
  html += field(s.lane, esc(e.track));
  html += field(s.stream, `${esc(e.stream)}${st ? ` · ${esc(st.role)}` : ''}`, true);
  html += field(s.segment, seg ? esc(seg.id.replace(/^segment\//, '')) : '—');
  html += field(s.talk, e.talk ? esc(e.talk.replace(/^talk\//, '')) : '—', true);
  html += field(s.run, e.run ? esc(e.run.replace(/^run\//, '')) : '—', true);
  html += field(s.directParent, e.parent ? esc(e.parent) : '—', true);
  html += field(s.observedAt, e.at ? esc(f.dateTime(e.at)) : esc(s.unavailable));
  if (e.reqToRes != null) {
    html += field(s.requestToResult, `${esc(f.duration(e.reqToRes))} <span class="acv-faint">· ${esc(e.reqToResJoin ?? '')}</span>`);
  }
  html += field(
    s.duration,
    e.durationMs
      ? `${esc(f.duration(e.durationMs))}${e.durationHow ? ` <span class="acv-faint">· ${esc(e.durationHow)}</span>` : ''}`
      : `<span class="acv-faint">${esc(s.durationUnavailable)}</span>`,
  );
  if (e.reqToRes != null) {
    html += `<dt></dt><dd><div class="acv-warning" style="margin:0"><strong>${esc(s.requestToResultWhat)}</strong><br>${esc(s.requestToResultText)}</div></dd>`;
  }
  if (e.name) html += field(s.name, esc(e.name));
  if (e.failed !== undefined) html += field(s.failedField, e.failed ? esc(s.yes) : esc(s.no));
  if (e.state) html += field(s.contentState, esc(e.state));
  if (e.bytes) html += field(s.contentBytes, f.number(e.bytes));
  if (e.usage) {
    html += field(
      s.tokens,
      esc(
        fill(s.tokensText, {
          in: f.number(e.usage.in ?? 0),
          out: f.number(e.usage.out ?? 0),
          cacheRead: f.number(e.usage.cache_read ?? 0),
          cacheWrite: f.number(e.usage.cache_write ?? 0),
        }),
      ),
    );
  }
  html += `</dl>`;
  if (e.text) html += `<div class="acv-block">${esc(e.text)}</div>`;
  if (e.result) {
    html += `<div class="acv-kicker" style="margin-top:14px">${esc(s.result)}${e.failed ? ` · ${esc(s.failed)}` : ''}${
      e.resultBytes ? ` · ${f.number(e.resultBytes)} B` : ''
    }</div><div class="acv-block">${esc(e.result)}</div>`;
  } else if (e.state && e.state !== 'available') {
    html += `<div class="acv-warning"><strong>${esc(fill(s.contentUnavailable, { state: e.state }))}</strong><br>${esc(s.contentUnavailableText)}</div>`;
  }
  // The child agents this call started are relations, read in that tab.
  const folders = e.edges.filter((g) => g.type === 'starts' && g.dir === 'out');
  if (folders.length) {
    html += `<button type="button" class="acv-linkish" data-to-relations style="margin-top:14px">${esc(
      folders.length === 1 ? s.oneChildAgent : fill(s.childAgents, { n: folders.length }),
    )} — ${esc(s.openRelations)}</button>`;
  }
  if (state.navStack.length) html += `<button type="button" class="acv-btn" style="margin-top:12px" data-back-parent>${esc(s.backToParentStream)}</button>`;
  body.innerHTML = html;
  body.querySelector<HTMLElement>('[data-to-relations]')?.addEventListener('click', () => ctx.showTab('relations'));
  body.querySelector<HTMLElement>('[data-back-parent]')?.addEventListener('click', () => ctx.goBack());
}

function drawRelations(ctx: ViewContext, body: HTMLElement, e: Step): void {
  const { s, model: m, state } = ctx;
  const rels = e.edges;
  if (!rels.length) {
    body.innerHTML = `<div class="acv-empty">${esc(s.noRelation)}</div>`;
    return;
  }
  const children = rels.filter((r) => m.streamById.has(r.other));
  let html = '';
  if (children.length > 1) {
    html += `<div class="acv-warning"><strong>${esc(fill(s.agentsCreatedByCall, { n: children.length }))}</strong><br>${esc(s.agentsCreatedText)}</div>`;
  }
  html += `<div class="acv-relation-list">${rels
    .map((r) => {
      const cls = r.quality === 'exact_unique' ? '' : r.quality === 'strong_inference' ? ' inferred' : ' weak';
      const st = m.streamById.get(r.other);
      if (st) {
        // A relation to a stream is a child agent: named and opened, not shown
        // as a raw id with nowhere to go. One with no name of its own shows
        // what was first put into its context, which is at least what it read.
        const about = !st.label && st.talk ? m.talkById.get(st.talk) : undefined;
        return `<div class="acv-relation-card${cls}">
        <button type="button" data-open-child="${esc(st.name)}"><strong>${esc(r.type)} · ${esc(s.childStreamSingular)} ${esc(st.name.slice(0, 6))}</strong><br>${
          st.label ? `${esc(st.label)} →` : `${esc(s.openStream)} →`
        }</button>
        ${about?.label ? `<small class="acv-child-about">${esc(about.label.slice(0, 200))}</small>` : ''}
        <small>${esc(r.quality)}${r.via ? ` — ${esc(s.joinedOn)} ${esc(r.via)}` : ''}${st.named_by === 'journal' ? ` — ${esc(s.namedFromJournal)}` : ''}</small></div>`;
      }
      const known = !!m.step(r.other);
      return `<div class="acv-relation-card${cls}">
        <button type="button" ${known ? `data-rel="${esc(r.other)}"` : 'disabled'}><strong>${esc(r.dir === 'out' ? s.outgoing : s.incoming)} · ${esc(r.type)}</strong><br>${esc(r.other)}</button>
        <small>${esc(r.quality)}${r.via ? ` — ${esc(s.joinedOn)} ${esc(r.via)}` : ''}${known ? '' : `<br>${esc(s.otherEndOutside)}`}</small></div>`;
    })
    .join('')}</div>`;
  body.innerHTML = html;
  body.querySelectorAll<HTMLElement>('[data-rel]').forEach((b) => (b.onclick = () => ctx.select(b.dataset.rel!, true)));
  body.querySelectorAll<HTMLElement>('[data-open-child]').forEach(
    (b) =>
      (b.onclick = () => {
        state.navStack.push({ stream: state.stream!, sel: state.sel });
        ctx.switchStream(b.dataset.openChild!);
      }),
  );
}

/** Where the step was read from, and the text the document carries for it.
 *  The whole record is one more read away, offered only when the host can
 *  make it. */
async function drawEvidence(ctx: ViewContext, body: HTMLElement, e: Step): Promise<void> {
  const { s, f, state } = ctx;
  const refs: AszRef[] = (e.ref ? [e.ref] : []).concat(e.refs ?? []);
  const seen = new Set<string>();
  const list = refs.filter((r) => {
    const k = `${r.seq}/${r.row}/${r.block ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!list.length) {
    body.innerHTML = `<div class="acv-empty">${esc(s.derivedByAssembly)}</div>`;
    return;
  }
  const pick = (state.rawRef && list.find((r) => r.seq === state.rawRef!.seq && r.row === state.rawRef!.row)) ?? list[0]!;
  const role = (i: number): string =>
    e.kind === 'tool' || e.kind === 'agent.call' ? (i === 0 ? s.request : s.result) : list.length > 1 ? `${s.part} ${i + 1}` : s.record;
  const shown = e.text ? new TextEncoder().encode(e.text).length : 0;
  const clipped = e.bytes && shown && e.bytes > shown;
  body.innerHTML = `
    <div class="acv-kicker">${esc(s.landedPositions)}</div>
    <div class="acv-ref-row">${list
      .map(
        (r, i) => `<button type="button" class="acv-ref-chip${r === pick ? ' on' : ''}" data-ref="${r.seq}/${r.row}">
        <b>${esc(role(i))}</b><span>seq ${r.seq} · row ${r.row}${r.block != null ? ` · block ${r.block}` : ''}</span></button>`,
      )
      .join('')}</div>
    ${
      e.text
        ? `<div class="acv-kicker" style="margin-top:12px">${esc(s.clippedText)}${clipped ? ` · ${esc(fill(s.fullTextNote, { shown: f.number(shown), total: f.number(e.bytes!) }))}` : ''}</div>
      <div class="acv-block">${esc(e.text)}</div>`
        : ''
    }
    ${e.flags?.length ? `<div class="acv-kicker" style="margin-top:12px">${esc(s.flags)}</div><div class="acv-provenance">${e.flags.map((x) => `<span class="acv-source-badge">${esc(x)}</span>`).join('')}</div>` : ''}
    ${(e.dropped ?? []).map((d) => `<div class="acv-warning">${esc(s.dropped)} ${esc(d.what)} · ${f.number(d.bytes)} B<br>${esc(d.why ?? '')}</div>`).join('')}
    <div class="acv-explain-box"></div>
    <div class="acv-record-box">${
      ctx.loadRecord ? `<button type="button" class="acv-btn" data-load-record>${esc(s.loadFullRecord)}</button>` : ''
    }</div>`;
  body.querySelectorAll<HTMLElement>('[data-ref]').forEach(
    (b) =>
      (b.onclick = () => {
        const [seq, row] = b.dataset.ref!.split('/').map(Number);
        state.rawRef = { seq: seq!, row: row! };
        state.explain = null;
        ctx.drawInspector();
      }),
  );
  const loadBtn = body.querySelector<HTMLElement>('[data-load-record]');
  if (loadBtn && ctx.loadRecord) {
    loadBtn.onclick = async () => {
      const box = body.querySelector<HTMLElement>('.acv-record-box')!;
      box.innerHTML = `<div class="acv-empty">${esc(s.loadingRecord)}</div>`;
      let rec: LandedRecord;
      try {
        rec = await ctx.loadRecord!(pick);
      } catch {
        box.innerHTML = `<div class="acv-warning">${esc(s.recordFailed)}</div>`;
        return;
      }
      // The reader may have moved on while the record was read.
      if (!box.isConnected) return;
      box.innerHTML = `<div class="acv-kicker" style="margin-top:14px">${esc(s.theLandedRecord)}</div><pre class="acv-raw">${renderJSON(ctx, rec, 0)}</pre>`;
      box.querySelectorAll<HTMLElement>('[data-term]').forEach(
        (b) =>
          (b.onclick = (ev) => {
            ev.stopPropagation();
            state.explain = state.explain === b.dataset.term ? null : b.dataset.term!;
            box.querySelectorAll<HTMLElement>('[data-term]').forEach((x) => x.classList.toggle('on', x.dataset.term === state.explain));
            drawExplain(ctx, body);
          }),
      );
    };
  }
  drawExplain(ctx, body);
}

/** A name that can be explained carries a question mark. Everything else is
 *  printed plainly, so the marks mark something. */
function explainable(ctx: ViewContext, key: string): 'term' | 'field' | null {
  const g = ctx.glossary;
  if (!g) return null;
  if (g.terms?.[key]) return 'term';
  if (g.fields?.[key]) return 'field';
  return null;
}

export function renderJSON(ctx: ViewContext, v: unknown, depth: number, key?: string): string {
  const pad = '  '.repeat(depth);
  const label =
    key == null
      ? ''
      : explainable(ctx, key)
        ? `<span class="acv-jkey">"${esc(key)}"</span><button type="button" class="acv-q" data-term="${esc(key)}" aria-label="${esc(fill(ctx.s.whatDoesMean, { key }))}" title="${esc(fill(ctx.s.whatDoesMean, { key }))}">?</button>: `
        : `<span class="acv-jkey plain">"${esc(key)}"</span>: `;
  if (v === null) return `${pad}${label}<span class="acv-jnull">null</span>\n`;
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}${label}[]\n`;
    return `${pad}${label}[\n${v.map((x) => renderJSON(ctx, x, depth + 1)).join('')}${pad}]\n`;
  }
  if (typeof v === 'object') {
    const ks = Object.keys(v as object);
    if (!ks.length) return `${pad}${label}{}\n`;
    return `${pad}${label}{\n${ks.map((k) => renderJSON(ctx, (v as Record<string, unknown>)[k], depth + 1, k)).join('')}${pad}}\n`;
  }
  const cls = typeof v === 'number' ? 'acv-jnum' : typeof v === 'boolean' ? 'acv-jbool' : 'acv-jstr';
  const text = typeof v === 'string' ? `"${v.length > 300 ? `${v.slice(0, 300)}…` : v}"` : String(v);
  return `${pad}${label}<span class="${cls}">${esc(text)}</span>\n`;
}

/** The explanation for whichever name was asked about: which vocabulary it
 *  belongs to, what it means, what the runtime calls it and where that appears.
 *  Where the runtime has no word, it says so rather than leaving the row empty. */
function drawExplain(ctx: ViewContext, body: HTMLElement): void {
  const { s, state, glossary: g } = ctx;
  const host = body.querySelector<HTMLElement>('.acv-explain-box');
  if (!host) return;
  const key = state.explain;
  if (!key || !g) {
    host.innerHTML = '';
    return;
  }
  const t = g.terms?.[key];
  const rows: Array<[string, string]> = [];
  if (t) {
    rows.push([s.vocabulary, `${esc(s.modelOwnWord)} · <span class="mono">${esc(s.aszTerm)}</span>`]);
    rows.push([s.aszTerm, `<span class="mono">${esc(key)}</span>`]);
    rows.push([s.runtimeWord, t.native ? `<span class="mono">${esc(t.native)}</span>` : `<span class="acv-faint">${esc(s.runtimeNoWord)}</span>`]);
    rows.push([s.whereToLook, t.where ? esc(t.where) : `<span class="acv-faint">${esc(s.nowhereInSource)}</span>`]);
    if (t.note) rows.push([s.readCarefully, esc(t.note)]);
    rows.push([s.dialect, `<span class="mono">${esc(g.dialect)}</span>`]);
  } else {
    rows.push([s.vocabulary, `${esc(s.landedRecordField)} · <span class="mono">.sd</span>`]);
    rows.push([s.aszField, `<span class="mono">${esc(key)}</span>`]);
    rows.push([s.whatItIs, esc(g.fields[key] ?? '')]);
    rows.push([s.runtimeWord, `<span class="acv-faint">${esc(s.notApplicable)}</span>`]);
  }
  host.innerHTML = `<div class="acv-explain">
    <div class="acv-explain-head"><span class="acv-explain-title">${esc(key)}</span>
      <button type="button" class="acv-explain-close" aria-label="${esc(s.close)}">×</button></div>
    <dl class="acv-explain-rows">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></div>`;
  host.querySelector<HTMLElement>('.acv-explain-close')!.onclick = () => {
    state.explain = null;
    drawExplain(ctx, body);
  };
}

export { streamName };
