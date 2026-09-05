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
 * The frame around the workbench: the status strip with the integrity badge,
 * the overview panel, the talk list, and the talk header with its stream tabs.
 * The host draws the page header (brand, service, sender, sharing) above.
 */

import { esc } from '../dom.js';
import { fill } from '../strings.js';
import { streamName, type ViewContext } from './context.js';

export function drawStatus(ctx: ViewContext): void {
  const { model: m, s, f, state } = ctx;
  const sum = m.doc.summary;
  const span = sum.to && sum.from ? f.duration(sum.to - sum.from) : '—';
  const verified = m.doc.rounds.filter((r) => r.verified).length;
  const integrity =
    sum.state === 'verified' ? s.integrityVerified : sum.state === 'mismatch' ? s.integrityMismatch : s.integrityIncomplete;
  ctx.q('.acv-status').innerHTML =
    `<span class="acv-badge acv-integrity is-${esc(sum.state)}" title="${esc(`${verified}/${m.doc.rounds.length} ${s.roundsVerified} · ${m.doc.files.length} ${s.filesListed}`)}"><span class="acv-dot"></span>${esc(integrity)}${
      sum.problems.length ? ` · ${sum.problems.length} ${esc(s.problems)}` : ''
    }</span>` +
    `<span class="acv-badge"><span class="acv-dot"></span>${esc(s.round)} ${f.number(m.doc.head.round)}</span>` +
    `<span><strong>${f.number(m.doc.segments.length)}</strong> ${esc(s.segments)}</span>` +
    `<span><strong>${f.number(m.doc.streams.length)}</strong> ${esc(s.streams)}</span>` +
    `<span><strong>${f.number(m.talks.length)}</strong> ${esc(s.talks)}</span>` +
    `<span>${esc(span)} ${esc(s.span)}</span>` +
    (sum.unresolved ? `<span class="acv-warn">${f.number(sum.unresolved)} ${esc(s.unresolved)}</span>` : '') +
    `<button type="button" class="acv-overview-toggle" aria-expanded="${state.overviewOpen}" aria-controls="acv-overview">${esc(s.overview)} <span class="acv-chevron" aria-hidden="true">⌄</span></button>`;
  ctx.q('.acv-overview-toggle').addEventListener('click', () => {
    state.overviewOpen = !state.overviewOpen;
    ctx.q('.acv-overview').hidden = !state.overviewOpen;
    ctx.root.classList.toggle('acv-overview-open', state.overviewOpen);
    ctx.q('.acv-overview-toggle').setAttribute('aria-expanded', String(state.overviewOpen));
    ctx.drawTimeline();
  });
  if (sum.problems.length) {
    ctx.q('.acv-integrity').addEventListener('click', () => {
      const box = ctx.q('.acv-problems');
      box.hidden = !box.hidden;
    });
  }
  const problems = ctx.q('.acv-problems');
  problems.hidden = true;
  problems.innerHTML = sum.problems.length
    ? `<ul>${sum.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
    : '';
}

export function drawOverview(ctx: ViewContext): void {
  const { model: m, s, f } = ctx;
  const sum = m.doc.summary;
  const child = m.doc.streams.filter((x) => x.role !== 'main').length;
  const runs = sum.kinds?.run ?? 0;
  const quality = Object.entries(sum.quality ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${f.number(n)} ${k.replace(/_/g, ' ')}`)
    .join(' · ');
  const idle = /idle=([^\s,]+)/.exec(m.doc.policy)?.[1] ?? m.doc.policy;
  ctx.q('.acv-summary').innerHTML = `
    <div class="acv-cell acv-cell-primary"><div class="acv-kicker">${esc(s.session)}</div><strong>${esc(m.doc.sessions.join(', ') || m.doc.conversation)}</strong></div>
    <div class="acv-cell"><div class="acv-kicker">${esc(s.steps)}</div><strong>${f.number(sum.steps)}</strong>
      <div class="acv-cell-sub">${f.number(m.talks.length)} ${esc(s.talks)} · ${f.number(runs)} ${esc(s.runs)}</div></div>
    <div class="acv-cell"><div class="acv-kicker">${esc(s.childStreams)}</div><strong>${f.number(child)}</strong>
      <div class="acv-cell-sub">${esc(s.childStreamsNote)}</div></div>
    <div class="acv-cell"><div class="acv-kicker">${esc(s.relations)}</div><strong>${f.number(m.doc.relations.length)}</strong>
      <div class="acv-cell-sub">${esc(quality)}</div></div>
    <div class="acv-cell"><div class="acv-kicker">${esc(s.segments)}</div><strong>${f.number(m.doc.segments.length)}</strong>
      <div class="acv-cell-sub">${esc(s.activityWindows)}, ${esc(s.idle)} ${esc(idle)}</div></div>`;
}

/** The talk list. A child stream's talk is work inside a talk, reached from the
 *  nested lane and the stream tabs, so only the conversation's own talks are
 *  listed. */
export function drawTalkList(ctx: ViewContext): void {
  const { model: m, s, f, state } = ctx;
  const filter = ((ctx.q<HTMLInputElement>('.acv-talk-filter').value ?? '') as string).toLowerCase();
  const rows = m.talks.filter((t) => !t.child && (!filter || t.label.toLowerCase().includes(filter)));
  const list = ctx.q('.acv-talk-list');
  list.innerHTML =
    rows
      .map(
        (t) => `<button type="button" class="acv-pick${state.talk && t.id === state.talk.id ? ' on' : ''}" data-talk-pick="${esc(t.id)}">
      <b>${esc(t.label || s.noOpeningLine)}</b>
      <small>${esc(f.time(t.from))} · ${f.number(t.steps)} ${esc(s.steps.toLowerCase())} · ${t.runs}r${t.tools ? ` · ${t.tools} ${esc(s.tools)}` : ''}</small></button>`,
      )
      .join('') || `<div class="acv-empty">${esc(s.noTalkMatches)}</div>`;
}

/** The streams a talk is read against: the parent that opened this one, the
 *  stream itself, and the children it starts. A talk that fans out to forty
 *  children cannot have forty tabs, so the rest become one list. */
export function drawStreamTabs(ctx: ViewContext): void {
  const { model: m, s, f, state } = ctx;
  const t = state.talk;
  const own = state.stream ? m.streamByName.get(state.stream) : undefined;
  const list: Array<{ name: string; role: string; label: string; steps: number; isParent?: boolean; opener?: { step: string; talk: string | null } }> = [];
  if (own && own.role !== 'main') {
    const up = m.openerOf(own.name);
    if (up) {
      const parent = m.streamByName.get(up.step.stream);
      if (parent) list.push({ name: parent.name, role: parent.role, label: parent.label, steps: parent.steps, isParent: true, opener: { step: up.step.id, talk: up.talk } });
    }
  }
  if (own) list.push({ name: own.name, role: own.role, label: own.label, steps: own.steps });
  if (state.stream) {
    for (const fo of m.foldersFor(state.stream)) {
      if (!list.some((x) => x.name === fo.stream.name)) list.push({ name: fo.stream.name, role: fo.stream.role, label: fo.stream.label, steps: fo.stream.steps });
    }
  }
  const tabs = list.filter((x) => x.role === 'main' || x.name === state.stream);
  const rest = list.filter((x) => !tabs.includes(x));
  let html = tabs
    .map((x) =>
      x.isParent
        ? `<button type="button" class="acv-stream-btn up" data-up-stream="${esc(x.name)}" data-up-step="${esc(x.opener!.step)}" data-up-talk="${esc(x.opener!.talk ?? '')}" title="${esc(`${s.backToStream} ${x.name}`)}">↰ ${esc(streamName(ctx, x.name))}</button>`
        : `<button type="button" role="tab" class="acv-stream-btn${state.stream === x.name ? ' active' : ''}" aria-selected="${state.stream === x.name}" data-tab-stream="${esc(x.name)}" title="${esc(x.name)}">${x.role === 'main' ? '' : '↳ '}${esc(streamName(ctx, x.name))}</button>`,
    )
    .join('');
  if (rest.length) {
    html += `<select class="acv-stream-btn acv-child-pick" title="${esc(s.childStreams)}">
      <option value="">↳ ${rest.length} ${esc(rest.length === 1 ? s.childStreamSingular : s.childStreamPlural)}…</option>
      ${rest.map((x) => `<option value="${esc(x.name)}">${esc(x.label || `${s.childStreamSingular} ${x.name.slice(0, 6)}`)} · ${f.number(x.steps)} ${esc(s.steps.toLowerCase())}</option>`).join('')}</select>`;
  }
  const host = ctx.q('.acv-stream-tabs');
  host.innerHTML = html;
  host.querySelectorAll<HTMLElement>('[data-tab-stream]').forEach((b) => (b.onclick = () => ctx.switchStream(b.dataset.tabStream!)));
  host.querySelectorAll<HTMLElement>('[data-up-stream]').forEach(
    (b) => (b.onclick = () => ctx.goToOpener(b.dataset.upStream!, b.dataset.upStep!, b.dataset.upTalk || null)),
  );
  const pick = host.querySelector<HTMLSelectElement>('.acv-child-pick');
  if (pick) {
    pick.onchange = () => {
      if (!pick.value) return;
      state.navStack.push({ stream: state.stream!, sel: state.sel });
      ctx.switchStream(pick.value);
    };
  }
  // What this talk is, not what it says: the opening line is the first card
  // below and the talk list needs it to tell talks apart.
  const bits: string[] = [];
  if (t) {
    bits.push(own && own.role === 'main' ? s.mainStreamCaption : s.childStreamCaption);
    if (t.steps) bits.push(`${f.number(t.steps)} ${s.steps.toLowerCase()}`);
    if (t.runs) bits.push(`${t.runs} ${s.runs}`);
    if (t.tools) bits.push(`${f.number(t.tools)} ${s.tools}`);
    if (t.to > t.from) bits.push(f.duration(t.to - t.from));
  }
  const caption = ctx.q('.acv-talk-caption');
  caption.textContent = bits.join(' · ');
  caption.title = t ? t.id : '';
}

export function fmtNumberWord(ctx: ViewContext, n: number, singular: string, plural: string): string {
  return `${ctx.f.number(n)} ${n === 1 ? singular : plural}`;
}

export { fill };
