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
 * The whole stream, one talk after another: what was asked, what came back,
 * and the work between them folded away until it is wanted. A conversation
 * has hundreds of talks and tens of thousands of steps, so a talk's cards are
 * built from its own row — the opening line, the answer, the counts — and its
 * steps are laid out only while its fold is open.
 */

import { cssEscape, esc } from '../dom.js';
import type { Step, TalkRow } from '../model.js';
import { fill } from '../strings.js';
import { injectionSays, kindTitle, QUIET_MS } from '../vocabulary.js';
import { changePill, inlineChanges, redrawBoth } from './changes.js';
import { streamName, type ViewContext } from './context.js';
import { clipNote, copyButton, copyField, textBody } from './structured.js';

/** Characters past which a card clamps a text with a fade and offers the rest. */
const CLAMP_CHARS = 380;
/** Lines past which it does the same: a decoded command shows its newlines. */
const CLAMP_LINES = 6;

/** A step's input or result, clamped until opened, with the note where the
 *  document clipped it. */
function textBlock(ctx: ViewContext, e: Step, which: 'in' | 'out', text: string, bytes: number | undefined, cls: string): { html: string; fields: boolean } {
  const { s, state } = ctx;
  const body = textBody(text, e.kind, s);
  const key = `${e.id}|${which}`;
  const long = text.length > CLAMP_CHARS || body.lines > CLAMP_LINES;
  const open = long && state.openTexts.has(key);
  const note = clipNote(ctx, text, bytes);
  const more = long && !open ? `<button type="button" class="acv-linkish acv-text-more" data-text-toggle="${esc(key)}">${esc(s.showAllLines)}</button>` : '';
  return {
    html: `<span class="acv-text ${cls}${long && !open ? ' clamped' : ''}${open ? ' open' : ''}">${body.html}${
      note ? `<span class="acv-clip-note">${note}</span>` : ''
    }</span>${more}`,
    fields: body.fields,
  };
}

/** The result under a card: its label, with a copy button when the text is
 *  one piece rather than fields, then the text. */
function resultBlock(ctx: ViewContext, e: Step): string {
  const { s, f } = ctx;
  const out = textBlock(ctx, e, 'out', e.result!, e.resultBytes, 'mono result');
  return `<span class="acv-result-block" data-copy-scope><span class="acv-result-label">${esc(s.result)}${e.failed ? ` · ${esc(s.failed)}` : ''}${
    e.resultBytes ? ` · ${f.number(e.resultBytes)} B` : ''
  }${e.reqToRes != null ? ` · ${esc(f.duration(e.reqToRes))} ${esc(s.toReturn)}` : ''}${out.fields ? '' : copyButton(s, `${s.copy} ${s.result}`)}</span>
        ${out.html}</span>`;
}

interface Presentation {
  cls: string;
  role: string;
  color: string;
}

/** How one step presents itself: which card shape, which role label, which
 *  kind colour. */
function present(ctx: ViewContext, e: Step): Presentation {
  const { s, model: m } = ctx;
  const st = m.streamByName.get(e.stream);
  const agent = !st ? s.agent : st.role === 'main' ? s.mainAgent : st.label || s.childAgent;
  const child = st && st.role !== 'main' ? ' child' : '';
  switch (e.kind) {
    case 'message.external':
      return { cls: 'acv-message acv-human', role: s.externalInput, color: 'user' };
    case 'message.assistant':
      return { cls: 'acv-message acv-agent', role: `${agent} · ${s.response}`, color: 'assistant' };
    case 'agent.output':
      return { cls: 'acv-message acv-subagent', role: `${agent} · ${s.streamOutput}`, color: 'subagent-response' };
    case 'message.synthetic':
      return { cls: 'acv-message acv-agent', role: s.clientMadeMessage, color: 'error' };
    case 'context.injection': {
      const w = injectionSays(e.text);
      return { cls: 'acv-activity acv-instruction', role: `${s.contextPutIn}${w?.key ? ` · ${w.key}` : ''}`, color: 'instruction' };
    }
    case 'agent.call':
      return { cls: 'acv-activity acv-handoff', role: `${s.agentCallToChild} · ${agent} → ${s.childAgent.toLowerCase()}`, color: 'agent' };
    case 'runtime.notification':
      return { cls: 'acv-activity acv-handoff', role: `${s.notificationFromChild} · ${s.childAgent.toLowerCase()} → ${agent}`, color: 'agent' };
    case 'agent.launch_ack':
      return { cls: `acv-activity${child}`, role: `${agent} · ${s.launchAcknowledged}`, color: 'agent' };
    case 'llm.call':
      return { cls: `acv-activity${child}`, role: `${agent} · ${s.modelCall}`, color: 'model' };
    case 'thinking':
      return { cls: `acv-activity${child}`, role: `${agent} · ${s.reasoning}`, color: 'model' };
    case 'tool':
      return { cls: `acv-activity${child}`, role: `${agent} → ${s.toolWord} · ${e.name || s.callWord}`, color: 'tool' };
    default:
      return { cls: `acv-activity${child}`, role: `${agent} · ${kindTitle(e.kind, s)}`, color: 'instruction' };
  }
}

/** One step, as a card inside an opened talk. */
export function stepCard(ctx: ViewContext, e: Step, prev: Step | undefined, near: Set<string> | null): string {
  const { s, f, model: m, state } = ctx;
  let sep = '';
  if (prev && e.at && prev.at && e.at - prev.at > QUIET_MS) {
    sep = `<div class="acv-separator dormant">${esc(f.duration(e.at - prev.at))} ${esc(s.quiet)}</div>`;
  }
  const p = present(ctx, e);
  const mono = e.kind === 'tool' || e.kind === 'context.injection';
  const indent = Math.max(0, (e.depth || 1) - 1);
  const folder = e.edges.find((g) => g.type === 'starts' && g.dir === 'out');
  const fs = folder ? m.streamById.get(folder.other) : undefined;
  const link = fs
    ? `<button type="button" class="acv-stream-link" data-open="${esc(fs.name)}">${esc(s.openStream)} ${esc(fs.label || fs.name.slice(0, 10))} →</button>`
    : '';
  const unavailable = e.state && e.state !== 'available' ? `<span class="acv-mini acv-warn">[${esc(e.state)}]</span>` : '';
  const title = e.durationMs
    ? `${f.duration(e.durationMs)} ${s.turn}`
    : e.kind === 'context.injection' && injectionSays(e.text)
      ? injectionSays(e.text)!.says
      : e.name || kindTitle(e.kind, s);
  // A card is a div, not a button: the change pill and the file rows inside
  // it are buttons of their own, and a button cannot hold buttons. The list's
  // key handler gives it Enter and Space.
  return `${sep}<div class="acv-card ${p.cls}${e.id === state.sel ? ' selected' : ''}${
    near && !near.has(e.id) ? ' dim' : ''
  }" role="button" tabindex="0" data-card="${esc(e.id)}" title="${esc(s.locateInTimeline)}"${
    indent ? ` style="--indent:${indent};margin-left:${indent * 22}px;max-width:calc(100% - ${indent * 22}px)"` : ''
  }>
    <span class="acv-time"><strong>${esc(f.time(e.at))}</strong>${esc(e.kind)}</span>
    <span class="acv-content">
      <span class="acv-role">${esc(p.role)}</span>
      <span class="acv-title acv-kind-${p.color}"><span class="acv-type-mark"></span>${esc(title)}
        <span class="acv-mini">${e.bytes ? `${f.number(e.bytes)} B` : ''}</span> ${unavailable}${changePill(ctx, e)}</span>
      ${
        e.text
          ? `${e.result ? `<span class="acv-result-label">${esc(s.input)}${e.bytes ? ` · ${f.number(e.bytes)} B` : ''}</span>` : ''}
        ${textBlock(ctx, e, 'in', e.text, e.bytes, mono ? 'mono' : '').html}`
          : ''
      }
      ${e.result ? resultBlock(ctx, e) : ''}
      ${inlineChanges(ctx, e)}
    </span></div>${link}`;
}

function talkCards(ctx: ViewContext, t: TalkRow, prevTo: number | null): string {
  const { s, f, model: m, state } = ctx;
  const st = m.streamByName.get(t.stream);
  const isOpen = state.openTalks.has(t.id);
  const focused = state.talk?.id === t.id;
  // The two message cards name the step they stand for, so selecting that
  // step (a talk opens on its input) scrolls the transcript to the card.
  const talkSteps = m.stepsOfTalk(t.id);
  const opening = talkSteps.find((e) => e.kind === 'message.external') ?? talkSteps[0];
  const replies = talkSteps.filter((e) => e.kind === 'message.assistant' || e.kind === 'agent.output');
  const reply = replies[replies.length - 1];
  let html = '';
  if (prevTo && t.from && t.from - prevTo > QUIET_MS) {
    html += `<div class="acv-separator dormant">${esc(f.duration(t.from - prevTo))} ${esc(s.quiet)}</div>`;
  }
  html += `<button type="button" class="acv-card acv-message acv-human${focused ? ' focused' : ''}" data-talk="${esc(t.id)}"${opening ? ` data-step="${esc(opening.id)}"` : ''} title="${esc(s.showThisTalk)}">
    <span class="acv-time"><strong>${esc(f.time(t.from))}</strong>${esc(f.day(t.from))}</span>
    <span class="acv-content"><span class="acv-role">${esc(s.externalInput)}</span>
      <span class="acv-text${t.label.length > 380 ? ' clamped' : ''}">${esc(t.label || (t.child ? s.delegatedWork : s.noOpeningLine))}</span></span></button>`;
  if (t.steps) {
    const bits = [`${f.number(t.steps)} ${s.steps.toLowerCase()}`];
    if (t.runs) bits.push(`${t.runs} ${s.runs}`);
    if (t.tools) bits.push(`${f.number(t.tools)} ${s.tools}`);
    if (t.to > t.from) bits.push(f.duration(t.to - t.from));
    html += `<button type="button" class="acv-fold" data-work="${esc(t.id)}" aria-expanded="${isOpen}">
      <span class="acv-fold-mark">${isOpen ? '▾' : '▸'}</span>
      <span class="acv-fold-label">${esc(isOpen ? s.hideWork : s.showWork)}</span>
      <span class="acv-fold-stat">${esc(bits.join(' · '))}</span></button>`;
    if (isOpen) {
      const ev = m.stepsOfTalk(t.id);
      const near = m.relatedTo(state.picked && state.focus ? state.sel : null, state.folder, m.steps(t.stream));
      // The opening input and the closing answer each have a card of their own
      // outside the fold; inside it they would say the same thing twice.
      const closing = t.reply
        ? [...ev].reverse().find((e) => e.kind === 'message.assistant' || e.kind === 'agent.output')
        : undefined;
      const work = ev.filter((e) => e.kind !== 'message.external' && e !== closing);
      html += `<div class="acv-fold-body">${work.map((w, i) => stepCard(ctx, w, work[i - 1], near)).join('')}</div>`;
      // A long fold ends screens away from the button that opened it.
      html += `<button type="button" class="acv-fold" data-work="${esc(t.id)}" aria-expanded="true">
        <span class="acv-fold-mark">▴</span><span class="acv-fold-label">${esc(s.hideWork)}</span></button>`;
    }
  }
  if (t.reply) {
    html += `<button type="button" class="acv-card acv-message acv-agent${focused ? ' focused' : ''}" data-talk="${esc(t.id)}" data-end="reply"${reply ? ` data-step="${esc(reply.id)}"` : ''} title="${esc(s.showThisAnswer)}">
      <span class="acv-time"><strong>${esc(f.time(t.to))}</strong></span>
      <span class="acv-content">
        <span class="acv-role">${esc(st && st.role === 'main' ? s.mainAgent : s.childAgent)} · ${esc(s.response)}</span>
        <span class="acv-text${t.reply.length > 380 ? ' clamped' : ''}">${esc(t.reply)}</span>
      </span></button>`;
  }
  return html;
}

export function drawTranscript(ctx: ViewContext): void {
  const { s, model: m, state } = ctx;
  const list = ctx.q('.acv-transcript-list');
  const stream = state.stream;
  // A document that folded nothing has no stream to read either: say that,
  // not that a stream has no talks.
  const nothing = m.doc.summary.steps === 0 && m.doc.summary.problems.length > 0;
  if (!stream) {
    list.innerHTML = `<div class="acv-empty">${esc(nothing ? s.nothingFolded : s.noTalksInStream)}</div>`;
    return;
  }
  const talks = m.talksOf(stream);
  const loose = m.loose(stream);
  const st = m.streamByName.get(stream);
  const opened = st && st.role !== 'main' ? m.openerOf(st.name) : null;
  let html = '';
  if (st && st.role !== 'main') {
    html += `<div class="acv-stream-banner"><span><strong>${esc(st.label || st.name)}</strong><br>
      ${esc(s.independentStream)}
      ${opened ? `${esc(s.openedFrom)} <b>${esc(streamName(ctx, opened.step.stream))}</b> · ${esc(opened.quality)}.` : esc(s.noOpenerRecorded)}</span>
      ${opened ? `<button type="button" data-opener-stream="${esc(opened.step.stream)}" data-opener-step="${esc(opened.step.id)}" data-opener-talk="${esc(opened.talk ?? '')}">${esc(s.backToOpener)}</button>` : ''}</div>`;
  }
  if (!talks.length && !loose.length) {
    list.innerHTML = html + `<div class="acv-empty">${esc(nothing ? s.nothingFolded : s.noTalksInStream)}</div>`;
    return;
  }
  let prevTo: number | null = null;
  for (const t of talks) {
    html += talkCards(ctx, t, prevTo);
    prevTo = t.to || prevTo;
  }
  if (loose.length) {
    const near = m.relatedTo(state.picked && state.focus ? state.sel : null, state.folder, m.steps(stream));
    html += `<div class="acv-separator">${esc(s.outsideAnyTalk)}</div>
      <div class="acv-loose-note">${esc(s.outsideAnyTalkNote)}</div>
      <div class="acv-fold-body">${loose.map((w, i) => stepCard(ctx, w, loose[i - 1], near)).join('')}</div>`;
  }
  list.innerHTML = html;
}

/** One click handler for the whole list. A stream has hundreds of talks, and
 *  an opened fold thousands of cards; one listener beats one per card. */
export function bindTranscript(ctx: ViewContext): void {
  const list = ctx.q('.acv-transcript-list');
  list.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    const fold = target.closest<HTMLElement>('[data-work]');
    if (fold) {
      ev.stopPropagation();
      const id = fold.dataset.work!;
      ctx.state.autoOpen.delete(id);
      if (ctx.state.openTalks.has(id)) ctx.state.openTalks.delete(id);
      else ctx.state.openTalks.add(id);
      ctx.focusTalk(id);
      ctx.drawTranscript();
      return;
    }
    const open = target.closest<HTMLElement>('[data-open]');
    if (open) {
      ev.stopPropagation();
      ctx.selectFolder(open.dataset.open!);
      return;
    }
    // The change controls toggle their own state and redraw; none of them
    // moves the selection, so a reader can open a diff without losing it.
    const redraw = redrawBoth(ctx);
    const inList = (selector: string): string => `.acv-transcript-list ${selector}`;
    const pill = target.closest<HTMLElement>('[data-changes-toggle]');
    if (pill) {
      ev.stopPropagation();
      const id = pill.dataset.changesToggle!;
      if (ctx.state.openChanges.has(id)) ctx.state.openChanges.delete(id);
      else ctx.state.openChanges.add(id);
      redraw(inList(`[data-changes-toggle="${cssEscape(id)}"]`));
      return;
    }
    const fileRow = target.closest<HTMLElement>('[data-change-file]');
    if (fileRow) {
      ev.stopPropagation();
      const key = fileRow.dataset.changeFile!;
      if (ctx.state.openChangeFiles.has(key)) ctx.state.openChangeFiles.delete(key);
      else ctx.state.openChangeFiles.add(key);
      redraw(inList(`[data-change-file="${cssEscape(key)}"]`));
      return;
    }
    const more = target.closest<HTMLElement>('[data-diff-all]');
    if (more) {
      ev.stopPropagation();
      ctx.state.fullDiffs.add(more.dataset.diffAll!);
      redraw(inList(`[data-change-file="${cssEscape(more.dataset.diffAll!)}"]`));
      return;
    }
    const copy = target.closest<HTMLElement>('[data-copy]');
    if (copy) {
      ev.stopPropagation();
      copyField(copy, ctx.s.copied);
      return;
    }
    const textMore = target.closest<HTMLElement>('[data-text-toggle]');
    if (textMore) {
      ev.stopPropagation();
      const key = textMore.dataset.textToggle!;
      ctx.state.openTexts.add(key);
      redraw(inList(`[data-card="${cssEscape(key.slice(0, key.lastIndexOf('|')))}"]`));
      return;
    }
    const toChanges = target.closest<HTMLElement>('[data-to-changes]');
    if (toChanges) {
      ev.stopPropagation();
      ctx.select(toChanges.dataset.toChanges!, true, false);
      ctx.showTab('changes');
      return;
    }
    const card = target.closest<HTMLElement>('[data-card]');
    if (card) {
      ev.stopPropagation();
      ctx.select(card.dataset.card!, true, false);
      return;
    }
    const opener = target.closest<HTMLElement>('[data-opener-stream]');
    if (opener) {
      ctx.goToOpener(opener.dataset.openerStream!, opener.dataset.openerStep!, opener.dataset.openerTalk || null);
      return;
    }
    const talk = target.closest<HTMLElement>('[data-talk]');
    if (talk) {
      ctx.focusTalk(talk.dataset.talk!, talk.dataset.end);
      return;
    }
    ctx.clearFolder();
  });
  list.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const card = ev.target as HTMLElement;
    if (!card.matches('[data-card]')) return;
    ev.preventDefault();
    ctx.select(card.dataset.card!, true, false);
  });
}

export { fill };
