/*
 * Licensed to Apache Software Foundation (ASF) under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Apache Software Foundation (ASF) licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * The prompt of one call: what was sent to the model provider, and what came back.
 *
 * The document says only where the bodies landed. This tab loads the session's provider files up to
 * that position when the reader asks, rebuilds the two bodies, and shows them: the request whole or as
 * what it added to the call before it, and the response plainly. Nothing is loaded before the reader
 * presses the button, and what is loaded is kept, so the next call on the same session costs only the
 * files that landed after it.
 */

import { esc } from '../dom.js';
import type { Step } from '../model.js';
import { fill } from '../strings.js';
import type { AszProviderBody, AszRef } from '../types.js';
import {
  deltaOf,
  readBody,
  type PromptBlock,
  type PromptDelta,
  type PromptMessage,
  type ReadBody,
  type ReadRequest,
  type ReadResponse,
} from '../prompt/messages.js';
import { PromptError, ROLE_REQUEST, ROLE_RESPONSE, type PromptManifest } from '../prompt/store.js';
import type { ViewContext } from './context.js';
import { copyButton, copyField } from './structured.js';

/** Seqs asked for in one request, the OAP route's own limit. */
const BATCH = 32;
/** Text shown before a reader opens a block, in characters, and the same for a JSON value, which
 *  is read in its shape rather than as prose and takes more of it. */
const PREVIEW = 600;
const JSON_PREVIEW = 4000;

/** The provider bodies of a step, as the document lists them. */
export function bodiesOf(e: Step | null): AszProviderBody[] {
  return e?.providerBodies ?? [];
}

/** Whether the tab has anything to show: the host can read files and the call points at some. */
export function hasPrompt(ctx: ViewContext, e: Step | null): boolean {
  return !!ctx.loadFiles && bodiesOf(e).length > 0;
}

/** The session a body belongs to, and the provider files to load for it: every provider file of that
 *  session up to the body's own, since a body refers to what landed before it. */
function plan(ctx: ViewContext, ref: AszRef): { session: string; seqs: number[]; bytes: number } | null {
  const files = ctx.model.doc.files ?? [];
  const own = files.find((f) => f.kind === 'provider_body' && f.seq === ref.seq);
  if (!own) return null;
  const session = own.file.split('/')[0] ?? '';
  const earlier = files.filter((f) => f.kind === 'provider_body' && f.seq !== null && f.seq <= ref.seq && f.file.startsWith(`${session}/`));
  return {
    session,
    seqs: earlier.map((f) => f.seq!).sort((a, b) => a - b),
    bytes: earlier.reduce((n, f) => n + f.bytes, 0),
  };
}

/** What the tab draws from: the two sides a call lists, and the files they need. */
interface Sides {
  request?: AszRef;
  response?: AszRef;
  session: string;
  seqs: number[];
  bytes: number;
}

function sidesOf(ctx: ViewContext, e: Step): Sides | null {
  const bodies = bodiesOf(e);
  const request = bodies.find((b) => b.role === ROLE_REQUEST)?.ref;
  const response = bodies.find((b) => b.role === ROLE_RESPONSE)?.ref;
  const deepest = bodies.reduce<AszRef | null>((a, b) => (!a || b.ref.seq > a.seq ? b.ref : a), null);
  if (!deepest) return null;
  const p = plan(ctx, deepest);
  if (!p) return null;
  return { request, response, session: p.session, seqs: p.seqs, bytes: p.bytes };
}

export function drawPrompt(ctx: ViewContext, body: HTMLElement, e: Step): void {
  const { s, f, state } = ctx;
  const sides = sidesOf(ctx, e);
  if (!sides) {
    body.innerHTML = `<div class="acv-empty">${esc(s.promptNotHere)}</div>`;
    return;
  }
  const store = ctx.prompts.store(sides.session);
  const absent = sides.seqs.filter((seq) => !store.has(seq));
  const outcome = ctx.prompts.outcome(sides.session);
  // Nothing is read until the reader asks, and what has been asked is asked of each file, not of the
  // session: a call further on needs files the read before it never covered, and those are offered.
  // A file the read already covered is not offered again, whether the server left it out or answered
  // it with records that refer to a file which is not there: asking brings the same answer either way,
  // and the panel draws the bodies that did rebuild over a note naming what is not there. A read that
  // ended in an error is offered again whatever it covered, with what went wrong.
  const covered = new Set([...(outcome?.missing ?? []), ...(outcome?.unresolved ?? [])]);
  const unasked = outcome?.failed ? absent : absent.filter((seq) => !covered.has(seq));
  if (unasked.length) {
    drawUnloaded(ctx, body, sides, outcome?.failed);
    return;
  }
  // The side the reader last chose, when this call has it.
  if (state.promptSide === 'request' && !sides.request) state.promptSide = 'response';
  if (state.promptSide === 'response' && !sides.response) state.promptSide = 'request';
  const ref = state.promptSide === 'request' ? sides.request : sides.response;
  const role = state.promptSide === 'request' ? ROLE_REQUEST : ROLE_RESPONSE;

  let read: ReadBody | null = null;
  let manifest: PromptManifest | null = null;
  let failure = '';
  let bytes = 0;
  if (ref) {
    manifest = store.manifestAt(ref.seq, ref.row);
    try {
      const raw = store.bodyAt(ref.seq, ref.row);
      bytes = raw.length;
      read = readBody(raw, role);
    } catch (err) {
      failure = err instanceof PromptError ? err.message : String(err);
    }
  }

  const missing = absent.length
    ? `<div class="acv-warning">${esc(fill(s.promptFilesMissing, { seqs: absent.join(', ') }))}</div>`
    : '';
  const head = `
    <div class="acv-prompt-head">
      <div class="acv-prompt-ids">
        ${manifest?.model ? `<span class="acv-source-badge">${esc(manifest.model)}</span>` : ''}
        ${ref ? `<span class="acv-faint mono">seq ${ref.seq} · row ${ref.row}</span>` : ''}
        ${bytes ? `<span class="acv-faint">${esc(f.number(bytes))} B</span>` : ''}
      </div>
      <div class="acv-prompt-modes" role="group" aria-label="${esc(s.promptSides)}">
        ${sides.request ? sideButton(ctx, 'request', s.promptRequest) : ''}
        ${sides.response ? sideButton(ctx, 'response', s.promptResponse) : ''}
      </div>
    </div>`;

  let panel: string;
  try {
    panel = drawSide(ctx, e, read, sides, store, ref, failure);
  } catch (err) {
    // A body that verified can still be one this panel cannot draw - nested past what JSON.stringify
    // will walk, say. It says so, rather than leaving the tab empty.
    panel = `<div class="acv-warning">${esc(s.promptRebuildFailed)}<br>${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }

  body.innerHTML = `${missing}${head}${panel}`;
  wire(ctx, body);
}

/** The side the reader is on, drawn. Separated so that anything it throws is caught in one place. */
function drawSide(
  ctx: ViewContext,
  e: Step,
  read: ReadBody | null,
  sides: Sides,
  store: ReturnType<ViewContext['prompts']['store']>,
  ref: AszRef | undefined,
  failure: string,
): string {
  const { s, state } = ctx;
  let panel: string;
  if (!ref) {
    panel = `<div class="acv-empty">${esc(state.promptSide === 'request' ? s.promptNoRequest : s.promptNoResponse)}</div>`;
  } else if (failure) {
    panel = `<div class="acv-warning">${esc(s.promptRebuildFailed)}<br>${esc(failure)}</div>`;
  } else if (!read) {
    panel = `<div class="acv-warning">${esc(s.promptRebuildFailed)}</div>`;
  } else if (read.kind === 'request') {
    panel = drawRequest(ctx, e, read, sides, store);
  } else if (read.kind === 'response') {
    panel = drawResponse(ctx, e, read);
  } else if (read.text != null) {
    // the body rebuilt and matched its digest but is not JSON — a provider's plain error, say. It is
    // shown as the text it is; nothing about it is known beyond that.
    panel = section(ctx, e, 'raw', s.promptWholeBody, '', block(ctx, { kind: 'text', text: read.text }, `${e.id}|${state.promptSide}|raw`), true);
  } else {
    panel = section(ctx, e, 'raw', s.promptWholeBody, '', json(ctx, read.raw, `${e.id}|${state.promptSide}|raw`), true);
  }
  return panel;
}

function sideButton(ctx: ViewContext, side: 'request' | 'response', label: string): string {
  const on = ctx.state.promptSide === side;
  return `<button type="button" class="acv-chip${on ? ' on' : ''}" data-prompt-side="${side}" aria-pressed="${on}">${esc(label)}</button>`;
}

/** Before anything is read: what is there, what loading it costs, and one button. */
function drawUnloaded(ctx: ViewContext, body: HTMLElement, sides: Sides, failed?: string): void {
  const { s, f } = ctx;
  const store = ctx.prompts.store(sides.session);
  const missing = sides.seqs.filter((seq) => !store.has(seq));
  // A read of this session started from another call is this call's read too: both wait for the same
  // files. The button says so rather than starting a second read of the same bytes.
  const reading = ctx.prompts.reading(sides.session);
  body.innerHTML = `
    <div class="acv-prompt-offer">
      <div>${esc(sides.request && sides.response ? s.promptBothStored : sides.request ? s.promptRequestStored : s.promptResponseStored)}</div>
      <div class="acv-faint">${esc(fill(s.promptLoadCost, { files: String(missing.length), bytes: f.number(sides.bytes) }))}</div>
      <div class="acv-prompt-progress">${
        failed ? `<span class="acv-warning">${esc(fill(s.promptLoadFailed, { why: failed }))}</span>` : ''
      }</div>
      <button type="button" class="acv-btn" data-load-prompt ${reading ? 'disabled' : ''}>${esc(reading ? s.promptReading : s.promptLoad)}</button>
    </div>`;
  const button = body.querySelector<HTMLButtonElement>('[data-load-prompt]');
  const progress = body.querySelector<HTMLElement>('.acv-prompt-progress')!;
  if (!button || !ctx.loadFiles) return;
  button.onclick = async () => {
    button.disabled = true;
    progress.textContent = fill(ctx.s.promptLoading, { loaded: '0', total: String(missing.length) });
    try {
      await ctx.prompts.load(sides.session, sides.seqs, ctx.loadFiles!, BATCH, (loaded, total) => {
        if (progress.isConnected) progress.textContent = fill(ctx.s.promptLoading, { loaded: String(loaded), total: String(total) });
      });
    } catch {
      return; // the reader moved on and the read was ended
    }
    // The panel is drawn again whatever happened, and from the state the read left behind: the reader
    // may have moved to another call while it ran, and the offer this handler drew is gone with it.
    ctx.drawInspector();
  };
}

function drawRequest(ctx: ViewContext, e: Step, read: ReadRequest, sides: Sides, store: ReturnType<ViewContext['prompts']['store']>): string {
  const { s, f, state } = ctx;
  const previous = state.promptWhole ? null : previousRequest(ctx, e, sides, store);
  const modes = `
    <div class="acv-prompt-modes" role="group" aria-label="${esc(s.promptRequestModes)}">
      <button type="button" class="acv-chip${state.promptWhole ? ' on' : ''}" data-prompt-whole="1" aria-pressed="${state.promptWhole}">${esc(s.promptWholeRequest)}</button>
      <button type="button" class="acv-chip${state.promptWhole ? '' : ' on'}" data-prompt-whole="0" aria-pressed="${!state.promptWhole}">${esc(s.promptChanges)}</button>
    </div>`;
  if (!state.promptWhole) {
    if (previous === UNNAMED) return `${modes}<div class="acv-empty">${esc(s.promptNoPreviousNamed)}</div>`;
    if (!previous) return `${modes}<div class="acv-empty">${esc(s.promptNoPrevious)}</div>`;
    return `${modes}${drawDelta(ctx, e, deltaOf(previous, read), read, previous.messages.length)}`;
  }
  const system = read.system.length
    ? section(ctx, e, 'system', s.promptSystem, blockSummary(ctx, read.system), read.system.map((b, i) => block(ctx, b, `${e.id}|req|sys|${i}`)).join(''))
    : '';
  const tools = read.tools.length
    ? section(
        ctx,
        e,
        'tools',
        fill(s.promptTools, { count: String(read.tools.length) }),
        read.tools
          .slice(0, 3)
          .map((t) => t.name)
          .join(', '),
        read.tools.map((t, i) => tool(ctx, t, `${e.id}|req|tool|${i}`)).join(''),
      )
    : '';
  const messages = section(
    ctx,
    e,
    'messages',
    fill(s.promptMessages, { count: String(read.messages.length) }),
    fill(s.promptMessagesNote, { bytes: f.number(new TextEncoder().encode(JSON.stringify(read.raw['messages'])).length) }),
    read.messages.map((m, i) => message(ctx, m, i + 1, read.messages.length, `${e.id}|req|msg|${i}`)).join(''),
    true,
  );
  // A LangChain request carries nothing but its messages, and an empty section says nothing.
  const settings = Object.keys(read.rest).length
    ? section(ctx, e, 'settings', s.promptSettings, Object.keys(read.rest).join(', '), json(ctx, read.rest, `${e.id}|req|set`))
    : '';
  const whole = section(ctx, e, 'request-raw', s.promptWholeBody, '', json(ctx, read.raw, `${e.id}|req|raw`));
  return `${modes}${system}${tools}${messages}${settings}${whole}`;
}

/** A request that names no request before it: the first of its chain, or one whose runtime does not
 *  say, as a LangChain agent's does not. Nothing is missing then, and the panel must not say so. */
const UNNAMED = 'unnamed';

/** The request of the call before this one in the same chain, found by the ids the bodies carry:
 *  this request names the request before it, the response of that request names its call, and the
 *  document says where that call's request landed. A chain that cannot be followed gives nothing,
 *  because a copy segment is storage, not a relationship. */
function previousRequest(
  ctx: ViewContext,
  e: Step,
  sides: Sides,
  store: ReturnType<ViewContext['prompts']['store']>,
): ReadRequest | typeof UNNAMED | null {
  if (!sides.request) return null;
  const mine = store.manifestAt(sides.request.seq, sides.request.row);
  if (mine && !mine.previous_request) return UNNAMED;
  if (!mine?.previous_request) return null;
  const response = store.responseOfRequestId(mine.previous_request);
  if (!response?.manifest.call) return null;
  const call = response.manifest.call;
  for (const step of ctx.model.stepById.values()) {
    const bodies = bodiesOf(step);
    const theirResponse = bodies.find((b) => b.role === ROLE_RESPONSE)?.ref;
    const theirRequest = bodies.find((b) => b.role === ROLE_REQUEST)?.ref;
    if (!theirResponse || !theirRequest || step.id === e.id) continue;
    if (store.manifestAt(theirResponse.seq, theirResponse.row)?.call !== call) continue;
    try {
      const read = readBody(store.bodyAt(theirRequest.seq, theirRequest.row), ROLE_REQUEST);
      return read.kind === 'request' ? read : null;
    } catch {
      return null;
    }
  }
  return null;
}

function drawDelta(ctx: ViewContext, e: Step, delta: PromptDelta, read: ReadRequest, previousCount: number): string {
  const { s, f } = ctx;
  const changed = [
    delta.systemChanged ? s.promptSystem : '',
    delta.toolsChanged ? fill(s.promptTools, { count: String(read.tools.length) }) : '',
    delta.settingsChanged ? s.promptSettings : '',
  ].filter(Boolean);
  const notes = [
    `<div class="acv-faint">${esc(fill(s.promptShared, { count: String(delta.sharedMessages), bytes: f.number(delta.sharedBytes) }))}</div>`,
    // A compaction is not a fault: it is the runtime replacing the context with a summary, which the
    // conversation records as its own step. Saying which of the two happened is the whole value of
    // the note -- a warning on every ordinary growth would say nothing.
    delta.replaced
      ? `<div class="acv-faint">${esc(fill(s.promptCompacted, { before: String(previousCount), after: String(read.messages.length) }))}</div>`
      : delta.rewritten
        ? `<div class="acv-warning">${esc(s.promptRewritten)}</div>`
        : '',
    changed.length ? `<div class="acv-faint">${esc(fill(s.promptAlsoChanged, { what: changed.join(', ') }))}</div>` : '',
  ].join('');
  const added = delta.added.length
    ? delta.added
        .map((m, i) => message(ctx, m, delta.sharedMessages + i + 1, read.messages.length, `${e.id}|req|msg|${delta.sharedMessages + i}`))
        .join('')
    : `<div class="acv-empty">${esc(s.promptNothingAdded)}</div>`;
  return `${notes}<div class="acv-kicker" style="margin-top:12px">${esc(fill(s.promptAdded, { count: String(delta.added.length) }))}</div>${added}`;
}

function drawResponse(ctx: ViewContext, e: Step, read: ReadResponse): string {
  const { s } = ctx;
  const facts = [
    read.stopReason ? `<span class="acv-source-badge">${esc(fill(s.promptStopReason, { reason: read.stopReason }))}</span>` : '',
    read.id ? `<span class="acv-faint mono">${esc(read.id)}</span>` : '',
  ].join(' ');
  // Every count the provider reported, not only the whole numbers among them: a nested one, such as
  // what a cache write cost, is shown as the JSON it is rather than left out.
  const usage = read.usage
    ? `<div class="acv-provenance">${Object.entries(read.usage)
        .map(
          ([k, v]) =>
            `<span class="acv-source-badge">${esc(k)} ${esc(
              typeof v === 'number' || typeof v === 'string' ? String(v) : JSON.stringify(v) ?? '',
            )}</span>`,
        )
        .join('')}</div>`
    : '';
  const blocks = read.blocks.map((b, i) => block(ctx, b, `${e.id}|res|${i}`)).join('');
  // What the sections above do not show: the model, the type, a stop sequence, and whatever else the
  // provider sent. A body that verified is shown whole or not at all.
  const rest = Object.keys(read.rest).length
    ? section(ctx, e, 'response-settings', s.promptSettings, Object.keys(read.rest).join(', '), json(ctx, read.rest, `${e.id}|res|rest`))
    : '';
  const whole = section(ctx, e, 'response-raw', s.promptWholeBody, '', json(ctx, read.raw, `${e.id}|res|raw`));
  return `<div class="acv-prompt-facts">${facts}</div>${usage}${blocks}${rest}${whole}`;
}

/** One collapsible section, remembered per step so a reader's choice survives redraws. */
function section(ctx: ViewContext, e: Step, key: string, title: string, note: string, inner: string, openByDefault = false): string {
  const id = `${e.id}|${key}`;
  const open = ctx.state.openPromptSections.has(id) || (openByDefault && !ctx.state.openPromptSections.has(`-${id}`));
  return `
    <section class="acv-prompt-section">
      <button type="button" class="acv-prompt-head-btn" data-prompt-section="${esc(id)}" aria-expanded="${open}">
        <span class="acv-kicker">${esc(title)}</span>
        ${note ? `<span class="acv-faint">${esc(note)}</span>` : ''}
        <span class="acv-prompt-caret">${open ? '▾' : '▸'}</span>
      </button>
      ${open ? `<div class="acv-prompt-body">${inner}</div>` : ''}
    </section>`;
}

/**
 * One message, in a box of its own with its place in the request on it.
 *
 * A message holds one block or several - a reminder and the text beside it, an answer and the tool
 * it then used - and without the box a reader counts the blocks and finds more of them than the
 * section says there are messages.
 */
function message(ctx: ViewContext, m: PromptMessage, n: number, total: number, key: string): string {
  const { s } = ctx;
  return `
    <div class="acv-prompt-message">
      <div class="acv-prompt-message-head">
        <span class="acv-prompt-role">${esc(m.role || s.promptUnknownRole)}</span>
        <span class="acv-faint">${esc(fill(s.promptMessageOf, { n: String(n), total: String(total) }))}</span>
      </div>
      <div class="acv-prompt-message-body">${m.blocks.map((b, i) => block(ctx, b, `${key}|${i}`)).join('')}</div>
    </div>`;
}

/**
 * One block of a message.
 *
 * Every block is drawn the same way, whatever it holds: a label saying what it is, then the content
 * in a card of its own with a coloured edge naming its kind, the page's own colour for that kind.
 * A message holds several of these, and a reader has to be able to see where one ends — which text
 * the runtime injected, and which of them the person wrote.
 */
function block(ctx: ViewContext, b: PromptBlock, key: string): string {
  const { s } = ctx;
  if (b.kind === 'text' || b.kind === 'thinking') {
    const text = b.text ?? '';
    const label = b.kind === 'thinking' ? s.promptThinking : b.reminder ? s.promptReminder : '';
    // The label is the block's own, never the message's: a message whose first block the runtime
    // injected usually carries the person's text as its second, and the two must not read alike.
    const mark = b.kind === 'thinking' ? ' thinking' : b.reminder ? ' injected' : '';
    return `
      <div class="acv-prompt-block${mark}">
        ${label ? `<div class="acv-kicker">${esc(label)}</div>` : ''}
        ${textBlock(ctx, text, key)}
      </div>`;
  }
  if (b.kind === 'tool_use') {
    return `
      <div class="acv-prompt-block tool">
        <div class="acv-kicker">${esc(fill(s.promptToolUse, { name: b.name ?? '' }))}${blockId(ctx, b)}</div>
        ${json(ctx, b.json, key)}
      </div>`;
  }
  if (b.kind === 'tool_result') {
    // a result that failed and one that did not can carry the same text, and the panel must not make
    // them look alike
    return `
      <div class="acv-prompt-block tool${b.failed ? ' failed' : ''}">
        <div class="acv-kicker">${esc(b.failed ? s.promptToolFailed : s.promptToolResult)}${blockId(ctx, b)}</div>
        ${b.text != null ? textBlock(ctx, b.text, key) : json(ctx, b.json, key)}
      </div>`;
  }
  return `<div class="acv-prompt-block"><div class="acv-kicker">${esc(b.kind)}</div>${json(ctx, b.json, key)}</div>`;
}

/** The tool call a block is: its own id, or the one a result answers. */
function blockId(ctx: ViewContext, b: PromptBlock): string {
  return b.id ? ` <span class="acv-faint mono">${esc(fill(ctx.s.promptToolFor, { id: b.id }))}</span>` : '';
}

function tool(ctx: ViewContext, t: { name: string; description: string; raw: unknown }, key: string): string {
  const first = t.description.split('\n')[0] ?? '';
  return `
    <div class="acv-prompt-tool">
      <div class="acv-prompt-tool-name mono">${esc(t.name)}</div>
      <div class="acv-faint">${esc(first.length > 200 ? `${first.slice(0, 200)}…` : first)}</div>
      ${json(ctx, t.raw, key)}
    </div>`;
}

function blockSummary(ctx: ViewContext, blocks: PromptBlock[]): string {
  const bytes = new TextEncoder().encode(blocks.map((b) => b.text ?? '').join('')).length;
  return fill(ctx.s.promptBlocks, { count: String(blocks.length), bytes: ctx.f.number(bytes) });
}

/**
 * A text, cut short until the reader asks for the rest.
 *
 * The whole text is always in the page, hidden beside the button that copies it, so the copy is of
 * everything whatever is shown. What the reader opened is remembered per text, the way the
 * transcript remembers it, so it survives moving between the request and the response.
 */
function textBlock(ctx: ViewContext, text: string, key: string): string {
  const { s, state } = ctx;
  const long = text.length > PREVIEW;
  const open = long && state.openTexts.has(key);
  const more = long && !open ? `<button type="button" class="acv-linkish acv-text-more" data-text-toggle="${esc(key)}">${esc(s.showAllLines)}</button>` : '';
  return `<div class="acv-block" data-copy-scope>${esc(open || !long ? text : `${text.slice(0, PREVIEW)}…`)}${copyButton(
    s,
  )}<span class="acv-copy-src" hidden>${esc(text)}</span></div>${more}`;
}

function json(ctx: ViewContext, value: unknown, key: string): string {
  const { s, state } = ctx;
  const text = JSON.stringify(value, null, 2) ?? '';
  const long = text.length > JSON_PREVIEW;
  const open = long && state.openTexts.has(key);
  const more = long && !open ? `<button type="button" class="acv-linkish acv-text-more" data-text-toggle="${esc(key)}">${esc(s.showAllLines)}</button>` : '';
  return `<pre class="acv-raw" data-copy-scope>${esc(open || !long ? text : `${text.slice(0, JSON_PREVIEW)}…`)}${copyButton(
    s,
  )}<span class="acv-copy-src" hidden>${esc(text)}</span></pre>${more}`;
}

function wire(ctx: ViewContext, body: HTMLElement): void {
  body.querySelectorAll<HTMLElement>('[data-prompt-side]').forEach((b) => {
    b.onclick = () => {
      ctx.state.promptSide = b.dataset.promptSide as 'request' | 'response';
      ctx.drawInspector();
    };
  });
  body.querySelectorAll<HTMLElement>('[data-prompt-whole]').forEach((b) => {
    b.onclick = () => {
      ctx.state.promptWhole = b.dataset.promptWhole === '1';
      ctx.drawInspector();
    };
  });
  body.querySelectorAll<HTMLElement>('[data-prompt-section]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.promptSection!;
      const open = b.getAttribute('aria-expanded') === 'true';
      if (open) {
        ctx.state.openPromptSections.delete(id);
        ctx.state.openPromptSections.add(`-${id}`);
      } else {
        ctx.state.openPromptSections.delete(`-${id}`);
        ctx.state.openPromptSections.add(id);
      }
      ctx.drawInspector();
    };
  });
  body.querySelectorAll<HTMLElement>('[data-text-toggle]').forEach((b) => {
    b.onclick = () => {
      ctx.state.openTexts.add(b.dataset.textToggle!);
      ctx.drawInspector();
    };
  });
  // Copy takes the whole text, never the clipped preview the panel shows: every block holds its text
  // hidden beside the button, which is what copyField reads.
  body.querySelectorAll<HTMLElement>('.acv-copy').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      copyField(b, ctx.s.copied);
    };
  });
}
