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
 * The flow timeline: one stream on a time axis, one lane per kind of step,
 * the nested streams it started beneath, and the relations of the selected
 * step drawn between the lanes.
 *
 * The axis is gap-compressed — busy stretches take the width and a long pause
 * is cut to a short marked gap — and the canvas is as wide as the stream needs
 * at the chosen zoom. A stream can hold fifty thousand steps (measured on a
 * real corpus), so only the clips and time stamps inside the scrolled window
 * are in the DOM: positions are laid out for every step once per draw, and the
 * window is repainted on scroll.
 */

import { esc } from '../dom.js';
import type { Folder, Step } from '../model.js';
import { fill } from '../strings.js';
import { injectionSays, kindTitle, LANE_H, QUIET_MS, TRACK_NAME, TRACKS, type Track } from '../vocabulary.js';
import { streamName, type ViewContext } from './context.js';

interface Band {
  from: number;
  to: number;
  left: number;
  width: number;
}
interface Gap {
  left: number;
  width: number;
  ms: number;
}
interface Geometry {
  width: number;
  bands: Band[];
  gaps: Gap[];
  x(t: number): number;
}
interface Lane {
  key: string;
  label: string;
  y: number;
  color?: string;
  indent: boolean;
}
interface Layout {
  lanes: Lane[];
  rows: Record<string, number>;
  streamY: number;
  nestedY: number | null;
  height: number;
}
interface Pos {
  x: number;
  w: number;
  y: number;
  cx: number;
  cy: number;
}
interface Mark {
  x: number;
  t: number;
  every: number;
  newDay: boolean;
  label: boolean;
}
interface ShownFolder extends Folder {
  count: number;
  key: string;
}

/** Everything a repaint of the scrolled window needs, kept from the last draw. */
interface Paint {
  stream: string;
  ev: Step[];
  pos: Map<string, Pos>;
  marks: Mark[];
  folders: ShownFolder[];
  fpos: Map<string, Pos>;
  canvasW: number;
  height: number;
  near: Set<string> | null;
}

const paints = new WeakMap<ViewContext, Paint>();

/** Gap-compressed geometry: only the stretches where something happened take
 *  width; wall-clock is linear inside each. */
function geometry(ctx: ViewContext, ev: Step[]): Geometry {
  const timed = ev.filter((e) => e.at).sort((a, b) => a.at - b.at);
  // At 100% one step has about 104px of room — readable on its own.
  const width = Math.round(Math.max(1280, timed.length * 104) * ctx.state.zoom);
  const usable = width - 42;
  const left = 20;
  if (!timed.length) return { width, bands: [], gaps: [], x: () => left };
  const runs: Array<{ from: number; to: number }> = [];
  let cur = { from: timed[0]!.at, to: timed[0]!.at };
  for (const e of timed) {
    if (e.at - cur.to > QUIET_MS) {
      runs.push(cur);
      cur = { from: e.at, to: e.at };
    } else cur.to = e.at;
  }
  runs.push(cur);
  const active = runs.reduce((a, r) => a + Math.max(1, r.to - r.from), 0);
  const gapW = runs.length > 1 ? Math.min(90, usable * 0.07) : 0;
  const forBands = usable - gapW * (runs.length - 1);
  let x = left;
  const bands: Band[] = [];
  const gaps: Gap[] = [];
  runs.forEach((r, i) => {
    const w = Math.max(24, (forBands * Math.max(1, r.to - r.from)) / active);
    bands.push({ from: r.from, to: r.to, left: x, width: w });
    x += w;
    if (i < runs.length - 1) {
      gaps.push({ left: x, width: gapW, ms: runs[i + 1]!.from - r.to });
      x += gapW;
    }
  });
  return {
    width: Math.max(width, x + 20),
    bands,
    gaps,
    x(t: number): number {
      for (const b of bands) {
        if (t <= b.to) return b.left + (b.to === b.from ? 0 : ((t - b.from) / (b.to - b.from)) * b.width);
      }
      const last = bands[bands.length - 1]!;
      return last.left + last.width;
    },
  };
}

/** Where each lane sits. A lane is only given room when something is on it,
 *  and the nested lane sits directly under the agents lane, because the calls
 *  that start child streams live there. */
function layout(ctx: ViewContext, stream: string): Layout {
  const { s, model: m } = ctx;
  const used = new Set<Track>(m.flow(stream).map((e) => e.track));
  const nested = m.foldersFor(stream).length > 0;
  const lanes: Lane[] = [];
  let y = 24; // room for the time stamps floating above
  const streamY = y;
  y += 30;
  let nestedY: number | null = null;
  const addNested = (): void => {
    nestedY = y;
    lanes.push({ key: 'nested', label: s.laneNested, y, color: 'var(--acv-kind-agent)', indent: true });
    y += LANE_H;
  };
  for (const k of TRACKS) {
    if (used.has(k)) {
      lanes.push({ key: k, label: s[TRACK_NAME[k]], y, indent: true });
      y += LANE_H;
    }
    if (k === 'agents' && nested) addNested();
  }
  if (nested && nestedY === null) addNested();
  const rows: Record<string, number> = {};
  for (const l of lanes) rows[l.key] = l.y;
  return { lanes, rows, streamY, nestedY, height: y + 10 };
}

function drawLanes(ctx: ViewContext, L: Layout): void {
  const { model: m, state } = ctx;
  const gutter = ctx.q('.acv-lane-labels');
  const st = state.stream ? m.streamByName.get(state.stream) : undefined;
  if (!st) {
    gutter.innerHTML = '';
    return;
  }
  const child = st.role === 'main' ? '' : ' child';
  let html = `<div class="acv-stream-label${child}" style="top:${L.streamY}px">
    <button type="button" class="acv-stream-focus" title="${esc(st.name)}">${st.role === 'main' ? '▾ ' : '↳ '}${esc(streamName(ctx, st.name))}</button>
    <small>${esc(st.name.slice(0, 8))}</small></div>`;
  for (const l of L.lanes) {
    html += `<div class="acv-lane-label${l.indent ? child : ''}" style="top:${l.y}px${l.color ? `;color:${l.color}` : ''}">${esc(l.label)}</div>`;
  }
  html += `<div class="acv-lane-extent" style="top:${L.height - 1}px" aria-hidden="true"></div>`;
  gutter.innerHTML = html;
}

export function drawTimeline(ctx: ViewContext): void {
  const { s, f, model: m, state } = ctx;
  const stream = state.stream;
  const canvas = ctx.q('.acv-tl-canvas');
  const statics = ctx.q('.acv-tl-static');
  const scroll = ctx.q('.acv-tl-scroll');
  if (!stream) {
    statics.innerHTML = '';
    ctx.q('.acv-tl-items').innerHTML = '';
    paints.delete(ctx);
    return;
  }
  const L = layout(ctx, stream);
  drawLanes(ctx, L);
  const keepLeft = scroll.scrollLeft;
  const ev = m.flow(stream);
  const folders = m.foldersFor(stream);
  const g = geometry(ctx, ev);
  const st = m.streamByName.get(stream);
  ctx.q('.acv-tl-scope').textContent = st
    ? `${streamName(ctx, st.name)} · ${f.number(ev.length)} ${s.events}${folders.length ? ` · ${folders.length} ${s.nested}` : ''}`
    : '—';
  // Visible whenever this stream was opened by another, not only when the
  // reader walked in from it: landing on a child talk directly is the common
  // way to get here, and it leaves no history to go back through.
  const up = st && st.role !== 'main' ? m.openerOf(st.name) : null;
  const back = ctx.q<HTMLButtonElement>('.acv-tl-back');
  back.hidden = !up && !state.navStack.length;
  if (up) {
    back.textContent = `↰ ${streamName(ctx, up.step.stream)}`;
    back.dataset.upStream = up.step.stream;
    back.dataset.upStep = up.step.id;
    back.dataset.upTalk = up.talk ?? '';
  } else {
    back.textContent = s.parentTimeline;
    delete back.dataset.upStream;
    delete back.dataset.upStep;
    delete back.dataset.upTalk;
  }

  // Every candidate time on the axis is collected first, then labelled with a
  // pass that keeps them apart. Ticks land on real clock marks, and the
  // interval steps up when a smaller one would put labels too close to read.
  const LADDER = [1, 2, 5, 10, 15, 30, 60, 120, 360, 720, 1440].map((min) => min * 60_000);
  const marks: Mark[] = [];
  for (const b of g.bands) {
    const perMs = b.width / Math.max(1, b.to - b.from);
    const every = LADDER.find((ms) => ms * perMs >= 100) ?? LADDER[LADDER.length - 1]!;
    for (let t = Math.ceil(b.from / every) * every; t <= b.to; t += every) {
      const prev = t - every;
      marks.push({ x: b.left + (t - b.from) * perMs, t, every, newDay: prev < b.from || f.day(t) !== f.day(prev), label: false });
    }
  }
  marks.sort((a, b) => a.x - b.x);
  let lastLabel = -1e9;
  for (const mk of marks) {
    mk.label = mk.x - lastLabel >= 92;
    if (mk.label) lastLabel = mk.x;
  }

  // Positions, then untangle: several steps can carry the same moment, so a
  // clip that would land on its lane neighbour is moved just far enough to be
  // seen, and one that would run into the next is trimmed. The overlap is
  // taken out, never the time.
  const pos = new Map<string, Pos>();
  for (const e of ev) {
    const x = g.x(e.at);
    const y = L.rows[e.track] ?? L.streamY;
    pos.set(e.id, { x, w: 110, y, cx: x + 55, cy: y + 14 });
  }
  const lanes = new Map<string, Step[]>();
  for (const e of ev) {
    const k = e.track;
    const arr = lanes.get(k);
    if (arr) arr.push(e);
    else lanes.set(k, [e]);
  }
  for (const group of lanes.values()) {
    let right = -1e9;
    for (const e of group) {
      const q = pos.get(e.id)!;
      if (q.x < right) {
        q.x = right;
        q.cx = q.x + q.w / 2;
      }
      right = q.x + 24;
    }
    group.sort((a, b) => pos.get(a.id)!.x - pos.get(b.id)!.x);
    for (let i = 0; i < group.length - 1; i++) {
      const a = pos.get(group[i]!.id)!;
      const b = pos.get(group[i + 1]!.id)!;
      const room = b.x - a.x - 3;
      if (a.w > room) {
        a.w = Math.max(30, room);
        a.cx = a.x + a.w / 2;
      }
    }
  }

  // One call that starts a pool of agents is one thing on the nested lane,
  // not a queue: the clip says how many, the inspector says which.
  const groups = new Map<string, Folder[]>();
  for (const fo of folders) {
    const arr = groups.get(fo.from.id);
    if (arr) arr.push(fo);
    else groups.set(fo.from.id, [fo]);
  }
  const shown: ShownFolder[] = [...groups.values()].map((list) => ({
    ...list[0]!,
    count: list.length,
    key: list.length > 1 ? `group:${list[0]!.from.id}` : list[0]!.stream.name,
  }));
  const fpos = new Map<string, Pos>();
  let packed = 0;
  for (const fo of shown.sort((a, b) => (a.from.at || 0) - (b.from.at || 0))) {
    const w = 132;
    const x = Math.max(fo.from.at ? g.x(fo.from.at) + 24 : 20, packed);
    packed = x + w + 5;
    fpos.set(fo.key, { x, w, y: L.nestedY ?? L.streamY, cx: x + w / 2, cy: (L.nestedY ?? L.streamY) + 16 });
  }
  let canvasW = Math.max(g.width, packed + 40);
  for (const q of pos.values()) canvasW = Math.max(canvasW, q.x + q.w + 40);
  for (const q of fpos.values()) canvasW = Math.max(canvasW, q.x + q.w + 40);

  // The static layer: bands, gaps, track lines, and the relation edges of the
  // selection. Edges are few, so they are drawn whole; everything else is cheap.
  let html = '';
  g.bands.forEach((b, i) => {
    html += `<div class="acv-band${i % 2 ? ' alt' : ''}" style="left:${b.left}px;width:${Math.max(1, b.width)}px"></div>`;
  });
  for (const gp of g.gaps) {
    html += `<div class="acv-gap" style="left:${gp.left}px;width:${gp.width}px"></div>`;
    html += `<div class="acv-gap-label" style="left:${gp.left + gp.width / 2}px">${esc(f.duration(gp.ms))} ${esc(s.quiet)}</div>`;
  }
  for (const l of L.lanes) html += `<div class="acv-track-line" style="top:${l.y - 5}px"></div>`;
  html += edgesSvg(ctx, ev, pos, shown, fpos, canvasW, L.height);
  statics.innerHTML = html;
  canvas.style.width = `${canvasW}px`;
  canvas.style.height = `${L.height}px`;

  paints.set(ctx, {
    stream,
    ev,
    pos,
    marks,
    folders: shown,
    fpos,
    canvasW,
    height: L.height,
    near: m.relatedTo(state.picked && state.focus ? state.sel : null, state.folder, ev),
  });
  scroll.scrollLeft = keepLeft;
  paintViewport(ctx);
}

/** The relation edges of the selection, and the ownership curves from a model
 *  call to what it produced: containment is not a relation, so it carries no
 *  edge, but it is exactly the dependency a reader looks for between lanes. */
function edgesSvg(ctx: ViewContext, ev: Step[], pos: Map<string, Pos>, shown: ShownFolder[], fpos: Map<string, Pos>, w: number, h: number): string {
  const { state } = ctx;
  let html = `<svg class="acv-edges" viewBox="0 0 ${w} ${h}"><defs>
    <marker id="acv-arrow-exact" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="acv-arrow exact"></path></marker>
    <marker id="acv-arrow-inferred" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="acv-arrow inferred"></path></marker>
    <marker id="acv-arrow-weak" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="acv-arrow weak"></path></marker>
    <marker id="acv-arrow-owns" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="acv-arrow owns"></path></marker></defs>`;
  if (!state.sel && !state.folder) return `${html}</svg>`;
  const byId = new Map(ev.map((e) => [e.id, e]));
  for (const e of ev) {
    const parent = e.parent ? byId.get(e.parent) : undefined;
    if (!parent || parent.track === e.track) continue;
    if (e.id !== state.sel && parent.id !== state.sel) continue;
    const a = pos.get(parent.id);
    const b = pos.get(e.id);
    if (!a || !b) continue;
    const down = a.cy < b.cy;
    const sx = a.cx;
    const sy = a.cy + (down ? 14 : -14);
    const ex = b.cx;
    const ey = b.cy + (down ? -14 : 14);
    const lift = Math.max(10, Math.abs(ey - sy) * 0.5);
    html += `<path class="acv-owns selected" d="M ${sx} ${sy} C ${sx} ${sy + (down ? lift : -lift)}, ${ex} ${ey - (down ? lift : -lift)}, ${ex} ${ey}"></path>`;
  }
  const onScreen = new Set(ev.map((e) => e.id));
  const drawn = new Set<string>();
  for (const e of ev) {
    for (const rel of e.edges) {
      if (rel.dir !== 'out' || !onScreen.has(rel.other)) continue;
      if (e.id !== state.sel && rel.other !== state.sel) continue;
      const key = `${e.id}>${rel.other}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const a = pos.get(e.id);
      const b = pos.get(rel.other);
      if (!a || !b) continue;
      const sx = a.x + a.w;
      const sy = a.cy;
      const ex = b.x;
      const ey = b.cy;
      const bend = Math.max(18, Math.abs(ex - sx) * 0.42);
      const cls = rel.quality === 'exact_unique' ? '' : rel.quality === 'strong_inference' ? ' inferred' : ' weak';
      html += `<path class="acv-edge${cls} selected" d="M ${sx} ${sy} C ${sx + bend} ${sy}, ${ex - bend} ${ey}, ${ex} ${ey}"></path>`;
    }
  }
  // A nested stream's own link: the call that opened it, and nothing else
  // that call opened. It drops out of the call into the top of the child, and
  // climbs the other way for a stream reporting back.
  for (const fo of shown) {
    if (state.folder ? state.folder !== fo.stream.name : fo.from.id !== state.sel) continue;
    const a = pos.get(fo.from.id);
    const b = fpos.get(fo.key);
    if (!a || !b) continue;
    const sx = fo.back ? b.x + 26 : a.cx;
    const sy = fo.back ? b.y : a.y + 28;
    const ex = fo.back ? a.cx : b.x + 26;
    const ey = fo.back ? a.y + 28 : b.y;
    const lift = Math.max(12, Math.abs(ey - sy) * 0.5);
    const down = sy < ey ? 1 : -1;
    const cls = fo.quality === 'exact_unique' ? '' : fo.quality === 'strong_inference' ? ' inferred' : ' weak';
    html += `<path class="acv-edge drop${cls} selected" d="M ${sx} ${sy} C ${sx} ${sy + down * lift}, ${ex} ${ey - down * lift}, ${ex} ${ey}"></path>`;
  }
  return `${html}</svg>`;
}

/** Repaint the scrolled window: the ticks, the clips and the nested-stream
 *  clips whose x falls within a screen of the viewport on either side, plus
 *  the playhead. With no measured width (a test, a detached mount) everything
 *  is painted. */
export function paintViewport(ctx: ViewContext): void {
  const p = paints.get(ctx);
  if (!p) return;
  const { s, f, state } = ctx;
  const scroll = ctx.q('.acv-tl-scroll');
  const view = scroll.clientWidth;
  const lo = view ? scroll.scrollLeft - view : -Infinity;
  const hi = view ? scroll.scrollLeft + 2 * view : Infinity;
  const inView = (x: number, w: number): boolean => x + w >= lo && x <= hi;
  let html = '';
  for (const mk of p.marks) {
    if (!inView(mk.x, 100)) continue;
    const stamp = mk.every >= 60_000 ? f.timeShort(mk.t) : f.time(mk.t);
    html += `<div class="acv-tick" style="left:${mk.x}px">${mk.label ? `<span>${mk.newDay ? `${esc(f.day(mk.t))} ` : ''}${esc(stamp)}</span>` : ''}</div>`;
  }
  for (const e of p.ev) {
    const q = p.pos.get(e.id)!;
    if (!inView(q.x, q.w)) continue;
    const says = e.kind === 'context.injection' ? injectionSays(e.text) : null;
    html += `<button type="button" class="acv-clip acv-kind-${e.type}${e.id === state.sel ? ' selected' : ''}${
      p.near && !p.near.has(e.id) ? ' dim' : ''
    }" data-node="${esc(e.id)}" data-talk="${esc(e.talk ?? '')}" title="${esc(e.at ? `${f.time(e.at)} · ` : '')}${esc(kindTitle(e.kind, s))}${
      e.name ? ` · ${esc(e.name)}` : ''
    }" style="left:${q.x}px;top:${q.y}px;width:${q.w}px">${esc(says ? says.says : e.name || kindTitle(e.kind, s))}</button>`;
  }
  for (const fo of p.folders) {
    const q = p.fpos.get(fo.key)!;
    if (!inView(q.x, q.w)) continue;
    if (fo.count > 1) {
      html += `<button type="button" class="acv-clip acv-kind-agent nested${fo.from.id === state.sel ? ' selected' : ''}" data-group="${esc(fo.from.id)}" title="${esc(fill(s.poolTitle, { n: fo.count }))}" style="left:${q.x}px;top:${q.y}px;width:${q.w}px">${fo.count} ${esc(s.agentsCreated)}</button>`;
      continue;
    }
    html += `<button type="button" class="acv-clip acv-kind-agent nested${state.folder === fo.stream.name ? ' selected' : ''}${
      p.near && state.folder && state.folder !== fo.stream.name ? ' dim' : ''
    }" data-folder="${esc(fo.stream.name)}" title="${esc(fo.stream.label || fo.stream.name)} — ${esc(fo.quality)}. ${esc(fo.back ? s.reportedHere : s.clickToSeeOpener)}" style="left:${q.x}px;top:${q.y}px;width:${q.w}px">${esc(
      fo.stream.label || `${s.childStreamSingular} ${fo.stream.name.slice(0, 6)}`,
    )}</button>`;
  }
  const ph = state.sel ? p.pos.get(state.sel) : undefined;
  if (ph) html += `<div class="acv-playhead" style="left:${ph.cx}px"></div>`;
  ctx.q('.acv-tl-items').innerHTML = html;
}

/** The x of a step's centre on the current canvas, for scrolling to it without
 *  needing its clip in the DOM. */
export function centerX(ctx: ViewContext, id: string): number | null {
  const p = paints.get(ctx);
  const q = p?.pos.get(id);
  return q ? q.cx : null;
}

/** The nested lane's y, to bring a picked stream into view. */
export function folderBottom(ctx: ViewContext, name: string): number | null {
  const p = paints.get(ctx);
  if (!p) return null;
  const fo = p.folders.find((x) => x.stream.name === name);
  const q = fo ? p.fpos.get(fo.key) : undefined;
  return q ? q.y + 32 : null;
}

/** One listener for the canvas: a clip selects its step (opening the talk it
 *  belongs to), a nested clip points at the stream, a pool clip selects the
 *  call and opens the Relations tab, and empty canvas clears the selection. */
export function bindTimeline(ctx: ViewContext): void {
  const scroll = ctx.q('.acv-tl-scroll');
  const canvas = ctx.q('.acv-tl-canvas');
  canvas.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    const node = target.closest<HTMLElement>('[data-node]');
    if (node) {
      const tid = node.dataset.talk || null;
      if (tid && (!ctx.state.talk || ctx.state.talk.id !== tid)) ctx.openTalk(tid, true);
      // Folds this handler opened earlier are closed again: the reader asked
      // about one step, not about every talk they ever clicked through. Folds
      // opened by hand stay — they belong to the reader.
      for (const id of [...ctx.state.autoOpen]) {
        if (id !== tid) {
          ctx.state.openTalks.delete(id);
          ctx.state.autoOpen.delete(id);
        }
      }
      if (tid && !ctx.state.openTalks.has(tid)) {
        ctx.state.openTalks.add(tid);
        ctx.state.autoOpen.add(tid);
      }
      ctx.select(node.dataset.node!, true);
      return;
    }
    const folder = target.closest<HTMLElement>('[data-folder]');
    if (folder) {
      ev.stopPropagation();
      ctx.selectFolder(folder.dataset.folder!);
      return;
    }
    const group = target.closest<HTMLElement>('[data-group]');
    if (group) {
      ev.stopPropagation();
      ctx.select(group.dataset.group!, true);
      ctx.showTab('relations');
      return;
    }
    if (target.closest('button, a, select')) return;
    ctx.clearSelection();
  });
  let queued = false;
  scroll.addEventListener('scroll', () => {
    ctx.q('.acv-lane-labels').scrollTop = scroll.scrollTop;
    if (queued) return;
    queued = true;
    const g = globalThis as { requestAnimationFrame?: (cb: () => void) => number };
    const run = (): void => {
      queued = false;
      paintViewport(ctx);
    };
    if (typeof g.requestAnimationFrame === 'function') g.requestAnimationFrame(run);
    else setTimeout(run, 0);
  });
  // A wheel over the label gutter drives the canvas, so the two never diverge.
  ctx.q('.acv-lane-labels').addEventListener(
    'wheel',
    (e) => {
      if (!e.deltaY) return;
      e.preventDefault();
      scroll.scrollTop += e.deltaY;
    },
    { passive: false },
  );
}
