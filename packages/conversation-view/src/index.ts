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
 * Renders one AI agent conversation — an `asz.view` 1.0 document as the
 * SkyWalking AI Sessionizer assembles it and the OAP reproduces it — into a
 * host element: the transcript of talks, the flow timeline of one stream, and
 * an inspector that answers where each step came from.
 *
 * No framework and no network. The host parses and version-checks the
 * document, hands it in with the words it wants shown and the way it writes
 * times, and reads the reader's position back to keep in its URL. Horizon
 * wraps this in one small Vue component; the Sessionizer's own viewer embeds
 * the same build. Every colour and font is a Horizon design token, so the host
 * decides the theme by setting `data-theme` on `<html>`.
 */

import './styles.css';
import { esc, cssEscape, reducedMotion, scrollTo } from './dom.js';
import { EN_US_FORMATTER, type TimeFormatter } from './format.js';
import { ConversationModel, type Step } from './model.js';
import { ENGLISH, fill, type ViewStrings } from './strings.js';
import type { AszRef, AszViewDocument, Glossary, LandedRecord } from './types.js';
import { drawOverview, drawStatus, drawStreamTabs, drawTalkList } from './view/chrome.js';
import type { InspectorTab, ViewContext, ViewState } from './view/context.js';
import { drawInspector } from './view/inspector.js';
import { setupPanels } from './view/panels.js';
import { bindTimeline, centerX, drawTimeline, folderBottom, paintViewport } from './view/timeline.js';
import { bindTranscript, drawTranscript } from './view/transcript.js';

export type { TimeFormatter } from './format.js';
export { makeFormatter, EN_US_FORMATTER } from './format.js';
export type { ViewStrings } from './strings.js';
export { ENGLISH } from './strings.js';
export * from './types.js';

/** The reader's position, as a host keeps it in its URL. */
export interface PublicState {
  talk?: string;
  step?: string;
  stream?: string;
}

export interface MountOptions {
  document: AszViewDocument;
  strings?: Partial<ViewStrings>;
  formatter?: TimeFormatter;
  glossary?: Glossary | null;
  /** Reads one landed record by address. Offered in the Evidence tab only when
   *  present: the Sessionizer's viewer has such an endpoint, the OAP has none. */
  loadRecord?: (ref: AszRef) => Promise<LandedRecord>;
  state?: PublicState;
  onStateChange?: (state: PublicState) => void;
}

export interface ConversationView {
  destroy(): void;
  /** Move the reader: a host applies a URL change it did not originate. */
  setState(state: PublicState): void;
  getState(): PublicState;
}

function skeleton(s: ViewStrings): string {
  return `
  <div class="acv-strip"><div class="acv-status"></div></div>
  <div class="acv-problems" hidden></div>
  <div class="acv-overview" hidden>
    <section class="acv-summary" aria-label="${esc(s.overview)}"></section>
    <div class="acv-picker">
      <div class="acv-picker-head"><span class="acv-kicker">${esc(s.talks)}</span><input class="acv-talk-filter" type="search" placeholder="${esc(s.filterTalks)}" aria-label="${esc(s.filterTalks)}"></div>
      <div class="acv-talk-list"></div>
    </div>
  </div>
  <section class="acv-workbench">
    <div class="acv-main">
      <section class="acv-transcript">
        <div class="acv-transcript-head">
          <div class="acv-heading"><h2>${esc(s.talk)}</h2><span class="acv-talk-caption"></span></div>
          <div class="acv-stream-tabs" role="tablist"></div>
        </div>
        <div class="acv-transcript-list"></div>
      </section>
      <div class="acv-splitter acv-split-inspector" role="separator" aria-orientation="vertical" tabindex="0"></div>
      <aside class="acv-inspector">
        <div class="acv-inspector-head">
          <div class="acv-heading"><span class="acv-kicker">${esc(s.inspector)}</span><h2 class="acv-inspector-title">—</h2></div>
          <div class="acv-inspector-meta"></div>
        </div>
        <div class="acv-tablist" role="tablist">
          <button class="acv-tab" type="button" role="tab" data-tab="details" aria-selected="true">${esc(s.details)}</button>
          <button class="acv-tab" type="button" role="tab" data-tab="relations" aria-selected="false">${esc(s.relations)}</button>
          <button class="acv-tab" type="button" role="tab" data-tab="evidence" aria-selected="false">${esc(s.evidence)}</button>
        </div>
        <div class="acv-inspector-body" role="tabpanel"></div>
      </aside>
    </div>
    <div class="acv-splitter acv-split-dock" role="separator" aria-orientation="horizontal" tabindex="0"></div>
    <section class="acv-dock">
      <div class="acv-toolbar">
        <div class="acv-control-group">
          <div class="acv-tl-heading"><strong>${esc(s.flowTimeline)} <button type="button" class="acv-q acv-dock-help-btn" aria-label="${esc(s.timelineHelp)}" title="${esc(s.timelineHelp)}">?</button></strong><small class="acv-tl-scope">—</small></div>
          <button type="button" class="acv-tl-back acv-btn" hidden>${esc(s.parentTimeline)}</button>
          <label class="acv-checkbox" title="${esc(s.fadeUnrelatedTitle)}"><input class="acv-focus" type="checkbox" checked> ${esc(s.fadeUnrelated)}</label>
        </div>
        <div class="acv-control-group">
          <label class="acv-control-label">${esc(s.zoom)}</label>
          <input class="acv-zoom" type="range" min="10" max="200" step="10" value="100" aria-label="${esc(s.zoom)}">
          <output class="acv-zoom-out">100%</output>
          <button type="button" class="acv-fit acv-btn" title="${esc(s.centerSelectedTitle)}">${esc(s.centerSelected)}</button>
        </div>
      </div>
      <div class="acv-dock-help acv-explain" hidden>
        <div class="acv-explain-head"><span class="acv-explain-title">${esc(s.flowTimeline)}</span><button type="button" class="acv-explain-close acv-dock-help-close" aria-label="${esc(s.close)}">×</button></div>
        <dl class="acv-explain-rows">
          <dt>${esc(s.helpWhat)}</dt><dd>${esc(s.helpWhatText)}</dd>
          <dt>${esc(s.helpHeading)}</dt><dd>${esc(s.helpHeadingText)}</dd>
          <dt>${esc(s.helpAxis)}</dt><dd>${esc(s.helpAxisText)}</dd>
          <dt>${esc(s.helpLinks)}</dt><dd>${esc(s.helpLinksText)}</dd>
          <dt>${esc(s.helpFade)}</dt><dd>${esc(s.helpFadeText)}</dd>
        </dl>
      </div>
      <div class="acv-tl-panel"><div class="acv-tl-layout">
        <div class="acv-lane-labels"></div>
        <div class="acv-tl-scroll"><div class="acv-tl-canvas"><div class="acv-tl-static"></div><div class="acv-tl-items"></div></div></div>
      </div></div>
      <div class="acv-legend">
        <span class="acv-legend-item acv-kind-user"><span class="acv-legend-swatch"></span>${esc(s.legendInput)}</span>
        <span class="acv-legend-item acv-kind-assistant"><span class="acv-legend-swatch"></span>${esc(s.legendResponse)}</span>
        <span class="acv-legend-item acv-kind-model"><span class="acv-legend-swatch"></span>${esc(s.legendModel)}</span>
        <span class="acv-legend-item acv-kind-tool"><span class="acv-legend-swatch"></span>${esc(s.legendTool)}</span>
        <span class="acv-legend-item acv-kind-agent"><span class="acv-legend-swatch"></span>${esc(s.legendAgent)}</span>
        <span class="acv-legend-item acv-kind-instruction"><span class="acv-legend-swatch"></span>${esc(s.legendContext)}</span>
        <span class="acv-legend-item" style="color:var(--acv-owns)"><span class="acv-legend-line"></span>${esc(s.legendOwns)}</span>
        <span class="acv-legend-item" style="color:var(--acv-edge)"><span class="acv-legend-line"></span>${esc(s.legendExact)}</span>
        <span class="acv-legend-item"><span class="acv-legend-line dashed"></span>${esc(s.legendInferred)}</span>
      </div>
    </section>
  </section>
  <div class="acv-sr" aria-live="polite"></div>`;
}

export function mountConversationView(host: HTMLElement, opts: MountOptions): ConversationView {
  const s: ViewStrings = { ...ENGLISH, ...(opts.strings ?? {}) };
  const model = new ConversationModel(opts.document);
  const root = host;
  root.classList.add('acv');
  root.innerHTML = skeleton(s);

  const state: ViewState = {
    talk: null,
    stream: null,
    sel: null,
    folder: null,
    rawRef: null,
    zoom: 1,
    focus: true,
    picked: false,
    tab: 'details',
    navStack: [],
    openTalks: new Set(),
    autoOpen: new Set(),
    explain: null,
    overviewOpen: false,
  };

  // A host applying a position (from its URL) must hear one change, the final
  // one: opening the talk on the way to the step emits the talk's default step
  // first, and a host that wrote that to its URL would then read it back and
  // move the reader off the step it was asked for.
  let muted = 0;
  const emit = (): void => {
    if (muted === 0) opts.onStateChange?.(getState());
  };
  const getState = (): PublicState => ({
    ...(state.talk ? { talk: state.talk.id } : {}),
    ...(state.sel ? { step: state.sel } : {}),
    ...(state.stream ? { stream: state.stream } : {}),
  });

  const ctx: ViewContext = {
    root,
    model,
    s,
    f: opts.formatter ?? EN_US_FORMATTER,
    glossary: opts.glossary ?? null,
    loadRecord: opts.loadRecord,
    state,
    q<T extends Element = HTMLElement>(selector: string): T {
      const el = root.querySelector<T>(selector);
      if (!el) throw new Error(`conversation-view: missing element ${selector}`);
      return el;
    },
    select,
    selectFolder,
    clearSelection,
    clearFolder,
    diveIn,
    goBack,
    goToOpener,
    openTalk,
    focusTalk,
    switchStream,
    showTab,
    renderAll,
    drawTimeline: () => drawTimeline(ctx),
    drawTranscript: () => drawTranscript(ctx),
    drawInspector: () => drawInspector(ctx),
    drawStreamTabs: () => drawStreamTabs(ctx),
    drawTalkList: () => drawTalkList(ctx),
    centerOn,
    announce: (text) => {
      ctx.q('.acv-sr').textContent = text;
    },
  };

  function renderAll(recenter = false): void {
    drawStreamTabs(ctx);
    drawTimeline(ctx);
    drawTranscript(ctx);
    drawInspector(ctx);
    if (recenter) centerOn(state.sel, 'auto');
    emit();
  }

  function openTalk(id: string, keepStack = false): void {
    const t = model.talkById.get(id);
    if (!t) return;
    state.talk = t;
    if (!keepStack) state.navStack = [];
    state.stream = t.stream;
    state.picked = false;
    state.folder = null;
    state.openTalks.clear();
    state.autoOpen.clear();
    const ev = model.stepsOfTalk(t.id);
    state.sel = ev[0]?.id ?? model.steps(t.stream)[0]?.id ?? null;
    drawTalkList(ctx);
    renderAll(true);
  }

  /** Point the flow timeline at a talk without moving the reader off it: the
   *  input card points at the step that opened it, the reply card at the
   *  answer that closed it. */
  function focusTalk(id: string, end?: string): void {
    const t = model.talkById.get(id);
    if (!t) return;
    state.talk = t;
    state.stream = t.stream;
    state.picked = false;
    const steps = model.stepsOfTalk(id);
    let op: Step | undefined;
    if (end === 'reply') {
      const replies = steps.filter((e) => e.kind === 'message.assistant' || e.kind === 'agent.output');
      op = replies[replies.length - 1] ?? steps[steps.length - 1];
    } else {
      op = steps.find((e) => e.kind === 'message.external') ?? steps[0];
    }
    if (op) state.sel = op.id;
    drawStreamTabs(ctx);
    drawTimeline(ctx);
    drawTranscript(ctx);
    drawInspector(ctx);
    if (op) centerOn(op.id, reducedMotion() ? 'auto' : 'smooth', false);
    emit();
  }

  function switchStream(name: string): void {
    if (state.stream === name) return;
    if (!model.streamByName.has(name)) return;
    state.stream = name;
    const ev = model.steps(name);
    if (ev.length && !ev.some((e) => e.id === state.sel)) state.sel = ev[0]!.id;
    renderAll(true);
  }

  function select(id: string, center: boolean, alsoTranscript = true): void {
    const e = model.step(id);
    if (!e) return;
    if (e.stream !== state.stream) {
      switchStream(e.stream);
    }
    if (e.talk && state.talk?.id !== e.talk) {
      const t = model.talkById.get(e.talk);
      if (t) state.talk = t;
    }
    state.sel = id;
    state.rawRef = null;
    state.folder = null;
    state.picked = true;
    drawStreamTabs(ctx);
    drawTimeline(ctx);
    drawTranscript(ctx);
    drawInspector(ctx);
    if (center) centerOn(id, reducedMotion() ? 'auto' : 'smooth', alsoTranscript);
    ctx.announce(fill(s.selected, { what: `${e.kind}${e.name ? ` ${e.name}` : ''}` }));
    emit();
  }

  /** Selecting a nested stream is not entering it: it shows which step opened
   *  it and offers the way in. Only Dive in leaves the stream being read. */
  function selectFolder(name: string): void {
    if (!state.stream) return;
    const f = model.foldersFor(state.stream).find((x) => x.stream.name === name);
    if (!f) return;
    state.folder = name;
    state.picked = true;
    state.sel = f.from.id;
    state.rawRef = null;
    drawTimeline(ctx);
    drawTranscript(ctx);
    drawInspector(ctx);
    centerOn(f.from.id, reducedMotion() ? 'auto' : 'smooth');
    const bottom = folderBottom(ctx, name);
    if (bottom !== null) {
      const sc = ctx.q('.acv-tl-scroll');
      const want = Math.max(0, bottom - sc.clientHeight + 12);
      if (want > sc.scrollTop) {
        sc.scrollTop = want;
        ctx.q('.acv-lane-labels').scrollTop = want;
      }
    }
    ctx.announce(fill(s.selectedNestedStream, { name: f.stream.label || name, kind: f.from.kind }));
    emit();
  }

  function clearSelection(): void {
    if (!state.folder && !state.sel && !state.picked) return;
    state.folder = null;
    state.sel = null;
    state.picked = false;
    state.rawRef = null;
    drawTimeline(ctx);
    drawTranscript(ctx);
    drawInspector(ctx);
    ctx.announce(s.selectionCleared);
    emit();
  }

  function clearFolder(): void {
    if (!state.folder) return;
    state.folder = null;
    state.picked = false;
    drawTimeline(ctx);
    drawTranscript(ctx);
    drawInspector(ctx);
  }

  function diveIn(): void {
    const name = state.folder;
    if (!name || !state.stream) return;
    state.navStack.push({ stream: state.stream, sel: state.sel });
    state.folder = null;
    switchStream(name);
  }

  function goBack(): void {
    const t = state.navStack.pop();
    if (!t) return;
    state.stream = t.stream;
    state.sel = t.sel;
    renderAll(true);
  }

  /** Back to the exact step in the parent stream that opened the one being
   *  read. The talk is what the transcript shows, so the opener's talk is
   *  opened first; switching stream alone would land on a stream whose talk
   *  is not the one in focus. */
  function goToOpener(stream: string, step: string, talk: string | null): void {
    muted++;
    try {
      if (talk && state.talk?.id !== talk) openTalk(talk, true);
      else if (stream !== state.stream) switchStream(stream);
      state.folder = null;
      select(step, true);
    } finally {
      muted--;
    }
    emit();
  }

  function showTab(tab: InspectorTab): void {
    state.tab = tab;
    root.querySelectorAll<HTMLElement>('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
    drawInspector(ctx);
  }

  function centerOn(id: string | null, behavior: ScrollBehavior, alsoTranscript = true): void {
    if (!id) return;
    const sc = ctx.q('.acv-tl-scroll');
    const cx = centerX(ctx, id);
    if (cx !== null) {
      scrollTo(sc, { left: Math.max(0, cx - sc.clientWidth / 2), behavior });
      // Programmatic scrolling repaints the window; a scroll event may not
      // follow in every engine, and the clip has to be there to be seen.
      paintViewport(ctx);
    }
    if (!alsoTranscript) return;
    const list = ctx.q('.acv-transcript-list');
    const card = list.querySelector<HTMLElement>(`[data-card="${cssEscape(id)}"]`);
    if (card) {
      // Measured through rectangles, not offsetTop: the card sits inside the
      // fold's own box, so offsetTop answers against that box.
      const top = card.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      scrollTo(list, { top: Math.max(0, top - list.clientHeight / 2 + card.offsetHeight / 2), behavior });
    }
  }

  // ---- wiring ----
  drawStatus(ctx);
  drawOverview(ctx);
  bindTranscript(ctx);
  bindTimeline(ctx);
  const teardownPanels = setupPanels(ctx);

  root.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab as InspectorTab)));
  ctx.q('.acv-dock-help-btn').onclick = () => {
    const box = ctx.q('.acv-dock-help');
    box.hidden = !box.hidden;
  };
  ctx.q('.acv-dock-help-close').onclick = () => {
    ctx.q('.acv-dock-help').hidden = true;
  };
  ctx.q<HTMLInputElement>('.acv-focus').onchange = (e) => {
    state.focus = (e.target as HTMLInputElement).checked;
    drawTimeline(ctx);
    drawTranscript(ctx);
  };
  ctx.q<HTMLInputElement>('.acv-zoom').oninput = (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    state.zoom = v / 100;
    ctx.q('.acv-zoom-out').textContent = `${v}%`;
    drawTimeline(ctx);
  };
  ctx.q('.acv-fit').onclick = () => centerOn(state.sel, 'smooth');
  ctx.q<HTMLButtonElement>('.acv-tl-back').onclick = () => {
    const b = ctx.q<HTMLButtonElement>('.acv-tl-back');
    if (b.dataset.upStream && b.dataset.upStep) goToOpener(b.dataset.upStream, b.dataset.upStep, b.dataset.upTalk || null);
    else goBack();
  };
  ctx.q<HTMLInputElement>('.acv-talk-filter').oninput = () => drawTalkList(ctx);
  ctx.q('.acv-talk-list').addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-talk-pick]');
    if (b) openTalk(b.dataset.talkPick!);
  });

  // Keys, only while the reader is in this component or nowhere in particular:
  // a host's own inputs and shortcuts keep theirs.
  const onKey = (e: KeyboardEvent): void => {
    const active = document.activeElement as HTMLElement | null;
    if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return;
    if (active && active !== document.body && !root.contains(active)) return;
    if (e.key === 'Escape') {
      clearSelection();
      return;
    }
    if (e.key === 'Enter' && state.folder) {
      if (active && active.closest('button, a, select, [tabindex]') && active !== root) return;
      e.preventDefault();
      diveIn();
      return;
    }
    const k = e.key.toLowerCase();
    if (k !== 'j' && k !== 'k') return;
    if (!state.stream) return;
    const ev = model.steps(state.stream);
    const i = ev.findIndex((x) => x.id === state.sel);
    if (i < 0) return;
    const next = ev[k === 'j' ? Math.min(ev.length - 1, i + 1) : Math.max(0, i - 1)];
    if (next) select(next.id, true);
  };
  document.addEventListener('keydown', onKey);

  // ---- first position ----
  function setState(pub: PublicState): void {
    muted++;
    try {
      applyState(pub);
    } finally {
      muted--;
    }
    emit();
  }

  function applyState(pub: PublicState): void {
    const step = pub.step ? model.step(pub.step) : null;
    if (step) {
      const talk = step.talk ?? model.talksOf(step.stream)[0]?.id;
      if (talk && state.talk?.id !== talk) openTalk(talk, true);
      else if (step.stream !== state.stream) switchStream(step.stream);
      select(step.id, true);
      return;
    }
    if (pub.talk && model.talkById.has(pub.talk)) {
      openTalk(pub.talk);
      if (pub.stream && pub.stream !== state.stream) switchStream(pub.stream);
      return;
    }
    if (pub.stream && model.streamByName.has(pub.stream)) {
      const first = model.talksOf(pub.stream)[0];
      if (first) openTalk(first.id);
      else {
        state.stream = pub.stream;
        state.sel = model.steps(pub.stream)[0]?.id ?? null;
        renderAll(true);
      }
      return;
    }
    const first = model.firstTalk();
    if (first) openTalk(first.id);
    else {
      // A document with no talk at all still has its streams and its loose steps.
      state.stream = model.doc.streams.find((x) => x.role === 'main')?.name ?? model.doc.streams[0]?.name ?? null;
      state.sel = state.stream ? (model.steps(state.stream)[0]?.id ?? null) : null;
      renderAll(true);
    }
  }
  setState(opts.state ?? {});

  return {
    destroy(): void {
      document.removeEventListener('keydown', onKey);
      teardownPanels();
      root.innerHTML = '';
      root.classList.remove('acv', 'acv-overview-open');
    },
    setState,
    getState,
  };
}
