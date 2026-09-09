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
 * The two splitters: the inspector's width and the timeline dock's height.
 * Both sizes are kept per browser and read back on mount; a stored value from
 * a much larger window is clamped, so a page opened on a small screen cannot
 * start with a panel wider than the screen.
 */

import type { ViewContext } from './context.js';

interface Panel {
  key: string;
  cssVar: string;
  handle: string;
  axis: 'x' | 'y';
  min: number;
  max: () => number;
  fallback: number | null;
  measure: (root: HTMLElement, e: PointerEvent) => number;
  current: (root: HTMLElement) => number;
}

const PANELS: Panel[] = [
  {
    key: 'acv.inspector',
    cssVar: '--acv-inspector',
    handle: '.acv-split-inspector',
    axis: 'x',
    min: 260,
    max: () => Math.max(280, (globalThis.innerWidth || 1280) - 420),
    fallback: 350,
    measure: (root, e) => root.querySelector('.acv-workbench')!.getBoundingClientRect().right - e.clientX,
    current: (root) => root.querySelector('.acv-inspector')!.getBoundingClientRect().width,
  },
  {
    key: 'acv.dock',
    cssVar: '--acv-dock',
    handle: '.acv-split-dock',
    axis: 'y',
    min: 150,
    max: () => Math.max(160, (globalThis.innerHeight || 800) - 260),
    fallback: null,
    measure: (root, e) => root.querySelector('.acv-workbench')!.getBoundingClientRect().bottom - e.clientY,
    current: (root) => root.querySelector('.acv-dock')!.getBoundingClientRect().height,
  },
];

function read(key: string): number {
  try {
    return Number(globalThis.localStorage?.getItem(key) ?? 0);
  } catch {
    return 0;
  }
}

function write(key: string, v: number): void {
  try {
    globalThis.localStorage?.setItem(key, String(v));
  } catch {
    /* private window */
  }
}

export function setupPanels(ctx: ViewContext): () => void {
  const { root } = ctx;
  const set = (p: Panel, px: number): number => {
    const v = Math.round(Math.min(p.max(), Math.max(p.min, px)));
    root.style.setProperty(p.cssVar, `${v}px`);
    write(p.key, v);
    return v;
  };
  const onResize = (): void => {
    for (const p of PANELS) set(p, p.current(root));
  };
  for (const p of PANELS) {
    const stored = read(p.key);
    if (stored > 0) set(p, stored);
    else if (p.fallback) set(p, p.fallback);
    const bar = root.querySelector<HTMLElement>(p.handle);
    if (!bar) continue;
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      root.classList.add('acv-resizing');
      const move = (ev: PointerEvent): void => {
        set(p, p.measure(root, ev));
      };
      const up = (ev: PointerEvent): void => {
        bar.releasePointerCapture(ev.pointerId);
        bar.classList.remove('dragging');
        root.classList.remove('acv-resizing');
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        // The timeline reads the height it was given, so it is redrawn once
        // the drag ends rather than on every pointer move.
        ctx.drawTimeline();
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
    // A splitter is a control, so it answers the arrow keys too.
    bar.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 48 : 12;
      const grow = p.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const shrink = p.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (e.key !== grow && e.key !== shrink && e.key !== 'Home') return;
      e.preventDefault();
      if (e.key === 'Home') set(p, p.fallback ?? Math.round((globalThis.innerHeight || 800) * 0.47));
      else set(p, p.current(root) + (e.key === grow ? step : -step));
      ctx.drawTimeline();
    });
  }
  globalThis.addEventListener?.('resize', onResize);
  return () => globalThis.removeEventListener?.('resize', onResize);
}
