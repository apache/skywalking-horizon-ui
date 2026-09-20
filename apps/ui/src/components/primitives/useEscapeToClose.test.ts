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
 * One Escape closes one box.
 *
 * Boxes nest — a long value opens over a span detail, which opens over a trace
 * popout — and each having its own window listener meant a single keypress
 * closed the whole stack. The order is by when a box OPENED, not when it
 * mounted: a child component mounts before its parent, so mount order says the
 * outermost is innermost.
 */

import { describe, it, expect } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useEscapeToClose } from './useEscapeToClose';

const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

/** A box whose open state the test drives, rendering its children inside. */
function box(open: Ref<boolean>, closed: string[], name: string) {
  return defineComponent({
    setup(_, { slots }) {
      useEscapeToClose(
        () => open.value,
        () => { closed.push(name); open.value = false; },
      );
      return () => h('div', slots.default?.());
    },
  });
}

describe('escape to close', () => {
  it('ranks two boxes that open in the SAME update by declaration order', () => {
    // One component owning both layers — a trace popout and the span panel
    // inside it — can have both become open at once: a link that names a span
    // opens a trace the cache already holds. Nothing happened "last" then, so
    // the order is the order they were DECLARED, and the outer box has to be
    // declared first or the first Escape tears down the whole trace.
    const closed: string[] = [];
    const trace = ref(false);
    const span = ref(false);
    const Both = defineComponent({
      setup() {
        useEscapeToClose(() => trace.value, () => { closed.push('trace'); trace.value = false; });
        useEscapeToClose(() => trace.value && span.value, () => { closed.push('span'); span.value = false; });
        return () => h('div');
      },
    });
    trace.value = true;
    span.value = true;
    const w = mount(Both);

    esc();
    expect(closed).toEqual(['span']);
    expect(trace.value).toBe(true);
    esc();
    expect(closed).toEqual(['span', 'trace']);
    w.unmount();
  });

  it('closes the innermost box, one per keypress', async () => {
    const closed: string[] = [];
    const outer = ref(true);
    const inner = ref(false);
    const Inner = box(inner, closed, 'inner');
    const Outer = box(outer, closed, 'outer');
    const w = mount(defineComponent({
      setup: () => () => h(Outer, null, { default: () => [h(Inner)] }),
    }));

    // The inner box opens LAST, though it mounted first.
    inner.value = true;
    await w.vm.$nextTick();

    esc();
    expect(closed).toEqual(['inner']);
    expect(outer.value).toBe(true);

    await w.vm.$nextTick();
    esc();
    expect(closed).toEqual(['inner', 'outer']);
    w.unmount();
  });

  it('ignores a box that is shut', async () => {
    const closed: string[] = [];
    const shut = ref(false);
    const open = ref(true);
    const w = mount(defineComponent({
      setup: () => () => h(box(shut, closed, 'shut'), null, { default: () => [h(box(open, closed, 'open'))] }),
    }));
    esc();
    expect(closed).toEqual(['open']);
    w.unmount();
  });

  it('answers a reopened box again, and in the new order', async () => {
    const closed: string[] = [];
    const a = ref(true);
    const b = ref(false);
    const w = mount(defineComponent({
      setup: () => () => h(box(a, closed, 'a'), null, { default: () => [h(box(b, closed, 'b'))] }),
    }));
    b.value = true;
    await w.vm.$nextTick();
    esc();
    expect(closed).toEqual(['b']);
    // Reopening b makes it the innermost again, ahead of a which never closed.
    b.value = true;
    await w.vm.$nextTick();
    esc();
    expect(closed).toEqual(['b', 'b']);
    expect(a.value).toBe(true);
    w.unmount();
  });

  it('stops listening once every box is gone', () => {
    const closed: string[] = [];
    const open = ref(true);
    const w = mount(box(open, closed, 'only'));
    w.unmount();
    esc();
    expect(closed).toEqual([]);
  });
});
