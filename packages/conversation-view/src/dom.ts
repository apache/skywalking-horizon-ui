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

/** Escape text for an HTML template. Every string from the document goes
 *  through this: titles, tool names and results are user data. */
export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' } as Record<string, string>
  )[c]!);
}

/** A CSS attribute-selector value. `CSS.escape` where the platform has it. */
export function cssEscape(v: string): string {
  const g = globalThis as { CSS?: { escape?: (s: string) => string } };
  if (g.CSS?.escape) return g.CSS.escape(v);
  return v.replace(/["\\]/g, '\\$&');
}

/** Scroll where the element supports it. jsdom and old engines have no
 *  `scrollTo` on elements, and a render must not die on a scroll. */
export function scrollTo(el: Element | null, opts: ScrollToOptions): void {
  if (!el) return;
  const target = el as Element & { scrollTo?: (o: ScrollToOptions) => void };
  if (typeof target.scrollTo === 'function') target.scrollTo(opts);
  else {
    if (opts.left !== undefined) target.scrollLeft = opts.left;
    if (opts.top !== undefined) target.scrollTop = opts.top;
  }
}

export function reducedMotion(): boolean {
  const g = globalThis as { matchMedia?: (q: string) => { matches: boolean } };
  return typeof g.matchMedia === 'function' && g.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Next paint, or soon, where there is no paint. */
export function nextFrame(fn: () => void): void {
  const g = globalThis as { requestAnimationFrame?: (cb: () => void) => number };
  if (typeof g.requestAnimationFrame === 'function') g.requestAnimationFrame(fn);
  else setTimeout(fn, 0);
}

/** The first element under `root` matching the selector, typed. */
export function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`conversation-view: missing element ${selector}`);
  return el;
}
