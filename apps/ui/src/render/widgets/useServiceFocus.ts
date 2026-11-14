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

import { onMounted, ref, watch, type Ref, type WatchSource } from 'vue';

/**
 * The service picked in a trace detail's service legend, whose spans every
 * view of that trace (waterfall rows, tree nodes, statistics rows) highlights.
 * Clicking the picked service again clears it; another trace clears it too,
 * so a highlight never carries over to a trace it was not picked in.
 */
export function useServiceFocus(trace: WatchSource<unknown>) {
  const focusService = ref<string | null>(null);
  watch(trace, () => { focusService.value = null; });
  function toggleFocus(service: string): void {
    focusService.value = focusService.value === service ? null : service;
  }
  return { focusService, toggleFocus };
}

/** Scrolls the first highlighted row under `root` to the middle of the lists
 *  holding it, unless it is in view already — then nothing moves. Only real
 *  scroll containers and the page move: `scrollIntoView` also scrolls an
 *  `overflow: hidden` card, which then clips its own header. */
export function revealFirstHighlighted(root: Element | null | undefined): void {
  const row = root?.querySelector('.svc-hl');
  if (!row || fullyVisible(row)) return;
  for (let p = row.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && p.scrollHeight > p.clientHeight) {
      const r = row.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      p.scrollTop += r.top - pr.top - (pr.height - r.height) / 2;
    }
  }
  const r = row.getBoundingClientRect();
  if (r.top < 0 || r.bottom > window.innerHeight) window.scrollBy(0, r.top - (window.innerHeight - r.height) / 2);
}

/** Inside the window and inside every clipping ancestor — a popout's list
 *  scrolls within a card that itself sits in the window. */
function fullyVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowY === 'visible') continue;
    const pr = p.getBoundingClientRect();
    if (r.top < pr.top || r.bottom > pr.bottom) return false;
  }
  return r.top >= 0 && r.bottom <= window.innerHeight;
}

/** A highlight view's rows: brings the first highlighted one into view when a
 *  service is picked, and when the view opens with one already picked. */
export function useRevealHighlighted(root: Ref<Element | null>, focusService: () => string | null | undefined): void {
  const reveal = (): void => { if (focusService()) revealFirstHighlighted(root.value); };
  watch(focusService, reveal, { flush: 'post' });
  onMounted(reveal);
}
