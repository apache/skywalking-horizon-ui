// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements.  See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { ProfileAnalyzationTree } from '@/api/client';
import { i18n } from '@/i18n';
import ProfileStackTable from './ProfileStackTable.vue';

/** Thread.run → Controller.handle → Service.work (the slow leaf), plus a
 *  sibling branch, so a collapsed root hides both the match and the slow frame. */
const TREE: ProfileAnalyzationTree = {
  elements: [
    { id: '1', parentId: '0', codeSignature: 'java.lang.Thread.run', duration: 100, durationChildExcluded: 0, count: 10 },
    { id: '2', parentId: '1', codeSignature: 'com.example.Controller.handle', duration: 100, durationChildExcluded: 5, count: 10 },
    { id: '3', parentId: '2', codeSignature: 'com.example.Service.work', duration: 90, durationChildExcluded: 90, count: 9 },
    { id: '4', parentId: '1', codeSignature: 'com.example.Other.idle', duration: 0, durationChildExcluded: 0, count: 1 },
  ],
};

function mountTable(props: Partial<{ search: string; highlightTop: boolean; hidePatterns: string[] }> = {}) {
  return mount(ProfileStackTable, {
    props: { trees: [TREE], highlightTop: false, ...props },
    attachTo: document.body,
    global: { plugins: [i18n] },
  });
}

const scrolled = vi.fn();
beforeEach(() => {
  scrolled.mockReset();
  Element.prototype.scrollIntoView = scrolled;
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** jsdom lays nothing out: place the table's viewport at 0–200 and the slow
 *  rows either inside it or far below. */
function layOut(slowRowsInView: () => boolean): void {
  const rect = (top: number, bottom: number) =>
    ({ top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('stack-scroll')) return rect(0, 200);
    if (this.classList.contains('is-top')) return slowRowsInView() ? rect(100, 126) : rect(900, 926);
    return rect(0, 0);
  });
}

/** A table whose host follows its top-slow updates, as `v-model` does. */
function mountBound() {
  const w = mount(ProfileStackTable, {
    props: {
      trees: [TREE],
      highlightTop: false,
      'onUpdate:highlightTop': (v: boolean) => void w.setProps({ highlightTop: v }),
    },
    attachTo: document.body,
    global: { plugins: [i18n] },
  });
  return w;
}

const signatures = (w: ReturnType<typeof mountTable>) => w.findAll('.sig-text').map((s) => s.text());

describe('ProfileStackTable', () => {
  it('a caret closes a row and opens it again', async () => {
    const w = mountTable();
    await w.find('.caret').trigger('click');
    expect(signatures(w)).toEqual(['java.lang.Thread.run']);
    await w.find('.caret').trigger('click');
    expect(signatures(w)).toHaveLength(4);
  });

  it('a search jump opens the collapsed rows above the match', async () => {
    const w = mountTable();
    await w.find('.caret').trigger('click');
    await w.setProps({ search: 'Service.work' });
    await (w.vm as unknown as { jumpToNext(kind: 'match' | 'top'): Promise<void> }).jumpToNext('match');
    await nextTick();
    expect(signatures(w)).toContain('com.example.Service.work');
    const current = w.find('.row.is-current');
    expect(current.exists()).toBe(true);
    expect(current.text()).toContain('com.example.Service.work');
    expect(scrolled).toHaveBeenCalled();
  });

  it('a new analysis drops the current match, whose key the new tree may reuse', async () => {
    const w = mountTable({ search: 'Service.work' });
    await (w.vm as unknown as { jumpToNext(kind: 'match' | 'top'): Promise<void> }).jumpToNext('match');
    await nextTick();
    expect(w.find('.row.is-current').exists()).toBe(true);
    const other: ProfileAnalyzationTree = {
      elements: TREE.elements.map((e) => (e.id === '3' ? { ...e, codeSignature: 'com.example.Database.query' } : e)),
    };
    await w.setProps({ trees: [other] });
    expect(w.find('.row.is-current').exists()).toBe(false);
  });

  it('turning top slow on opens the way to the slowest frame and scrolls to it', async () => {
    const w = mountTable();
    await w.find('.caret').trigger('click');
    await w.setProps({ highlightTop: true });
    await nextTick();
    await nextTick();
    // Both non-zero self times are among the ten largest; the jump goes to
    // the first in tree order.
    const top = w.findAll('.row.is-top').map((r) => r.find('.sig-text').text());
    expect(top).toEqual(['com.example.Controller.handle', 'com.example.Service.work']);
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it('a table that appears with top slow on lands on the first slow frame; the next-slow jump walks on and wraps', async () => {
    const w = mountTable({ highlightTop: true });
    const jump = (w.vm as unknown as { jumpToNext(kind: 'match' | 'top'): Promise<void> }).jumpToNext;
    const current = () => w.find('.row.is-current .sig-text').text();
    await nextTick();
    await nextTick();
    expect(current()).toBe('com.example.Controller.handle');
    await jump('top');
    await nextTick();
    expect(current()).toBe('com.example.Service.work');
    await jump('top');
    await nextTick();
    expect(current()).toBe('com.example.Controller.handle');
  });

  it('scrolling the slow frames out of view after seeing them turns top slow off', async () => {
    let inView = true;
    layOut(() => inView);
    const w = mountBound();
    await w.setProps({ highlightTop: true });
    await nextTick();
    await nextTick();
    expect(w.find('.row.is-current').exists()).toBe(true);
    inView = false;
    await w.find('.stack-scroll').trigger('scroll');
    expect(w.emitted('update:highlightTop')?.at(-1)).toEqual([false]);
    expect(w.find('.row.is-top').exists()).toBe(false);
    expect(w.find('.row.is-current').exists()).toBe(false);
  });

  it('scrolling before a slow frame was ever in view leaves top slow on', async () => {
    layOut(() => false);
    const w = mountBound();
    await w.setProps({ highlightTop: true });
    await nextTick();
    await w.find('.stack-scroll').trigger('scroll');
    expect(w.emitted('update:highlightTop')).toBeUndefined();
  });

  it('a header edge resizes its own column, widening the table; a double-click fits it again', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    const w = mountTable();
    await nextTick();
    const widths = () =>
      w.findAll('.stack-header .cell').map((c) => Number(/width: (\d+)px/.exec(c.attributes('style') ?? '')?.[1]));
    const total = () => widths().reduce((a, b) => a + b, 0);
    const handle = (i: number) => w.findAll('.stack-header .col-resize')[i];
    const dragBy = async (i: number, dx: number) => {
      await handle(i).trigger('mousedown', { clientX: 500 });
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 + dx }));
      document.dispatchEvent(new MouseEvent('mouseup'));
      await nextTick();
    };
    expect(widths()).toEqual([430, 120, 140, 110]);
    await dragBy(2, 100);
    expect(widths()).toEqual([430, 120, 240, 110]);
    await dragBy(0, 200);
    expect(widths()).toEqual([630, 120, 240, 110]);
    expect(total()).toBe(1100);
    await dragBy(1, -1000);
    expect(widths()[1]).toBe(60);
    await handle(3).trigger('dblclick');
    expect(widths()).toEqual([430, 120, 140, 110]);
    expect(total()).toBe(800);
  });

  it('a folded group keeps the self time of the frames in it', () => {
    const w = mountTable({ hidePatterns: ['com.example.Service'] });
    const group = w.findAll('.row').find((r) => r.find('.group').exists());
    expect(group?.find('.group').text()).toContain('1');
    expect(group?.findAll('.cell.num').map((c) => c.text())).toEqual(['90', '90', '9']);
  });
});
