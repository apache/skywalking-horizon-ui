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
 * Opening and closing the picker panel.
 *
 * Choosing a row has to close it. A panel left open floats over whatever
 * is beneath — on the translations page that is the preview canvas — so
 * the next click lands on a list row instead of the thing the operator
 * aimed at. It looks like the click did nothing.
 */

import { describe, it, expect } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import TypeaheadSelect from './TypeaheadSelect.vue';

const OPTIONS = [
  { value: 'overview', label: 'Overview' },
  { value: 'layer', label: 'Layer' },
];

/** The panel is teleported to <body> so no scrolling ancestor can clip
 *  it; `stubs: { teleport: true }` renders it in place so these assertions
 *  can still address it through the wrapper. Where it LANDS is asserted
 *  separately, below, without the stub. */
function open() {
  const w = mount(TypeaheadSelect, {
    props: { modelValue: 'overview', options: OPTIONS, ariaLabel: 'Kind' },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
  return w;
}

describe('the picker panel', () => {
  it('opens on the trigger', async () => {
    const w = open();
    expect(w.find('.tas__panel').exists()).toBe(false);
    await w.find('.tas__trigger').trigger('click');
    expect(w.find('.tas__panel').exists()).toBe(true);
  });

  it('closes when a row is chosen, and reports the choice', async () => {
    const w = open();
    await w.find('.tas__trigger').trigger('click');
    const rows = w.findAll('.tas__row');
    expect(rows).toHaveLength(2);
    await rows[1].trigger('click');
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['layer']);
    // The part that matters beyond the emit: nothing is left covering the
    // page.
    expect(w.find('.tas__panel').exists()).toBe(false);
  });

  it('cancels the click default, so a wrapping <label> cannot reopen it', async () => {
    // Callers put this control inside a <label>. A click on a plain <li>
    // there forwards to the label's control — the trigger — which toggles
    // the panel straight back open. jsdom does not implement that
    // forwarding, so the observable stand-in is that the row's click is
    // cancelled; a real browser then has nothing to forward.
    const w = open();
    await w.find('.tas__trigger').trigger('click');
    const row = w.findAll('.tas__row')[1].element;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    await w.vm.$nextTick();
    expect(ev.defaultPrevented).toBe(true);
    expect(w.find('.tas__panel').exists()).toBe(false);
  });

  it('closes on Escape', async () => {
    const w = open();
    await w.find('.tas__trigger').trigger('click');
    await w.find('.tas__panel').trigger('keydown', { key: 'Escape' });
    expect(w.find('.tas__panel').exists()).toBe(false);
  });

  it('closes on a click outside', async () => {
    const w = mount(TypeaheadSelect, {
      props: { modelValue: 'overview', options: OPTIONS, ariaLabel: 'Kind' },
      global: { plugins: [i18n], stubs: { teleport: true } },
      attachTo: document.body,
    });
    await w.find('.tas__trigger').trigger('click');
    expect(w.find('.tas__panel').exists()).toBe(true);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await w.vm.$nextTick();
    expect(w.find('.tas__panel').exists()).toBe(false);
    w.unmount();
  });

  it('stays shut when disabled', async () => {
    const w = mount(TypeaheadSelect, {
      props: { modelValue: 'overview', options: OPTIONS, ariaLabel: 'Kind', disabled: true },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
    await w.find('.tas__trigger').trigger('click');
    expect(w.find('.tas__panel').exists()).toBe(false);
  });
});

/**
 * Teleport is stubbed everywhere above, which is what makes these
 * necessary: with the stub, every assertion in this file passes on a panel
 * rendered inline — the exact arrangement that was clipped in production.
 */
describe('the panel escapes whatever is scrolling around it', () => {
  const mountReal = () =>
    mount(TypeaheadSelect, {
      props: { modelValue: 'overview', options: OPTIONS, ariaLabel: 'Kind' },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });

  it('renders in <body> rather than inside the component', async () => {
    const w = mountReal();
    await w.get('.tas__trigger').trigger('click');

    // Not a descendant of the component: an ancestor's `overflow` can only
    // clip what it contains, so this is the whole fix in one assertion.
    expect(w.find('.tas__panel').exists()).toBe(false);
    const panel = document.body.querySelector('.tas__panel');
    expect(panel).not.toBeNull();
    expect(w.element.contains(panel)).toBe(false);

    // Placed from the trigger's rect rather than by CSS flow.
    const style = panel!.getAttribute('style') ?? '';
    expect(style).toMatch(/left:/);
    expect(style).toMatch(/top:|bottom:/);
    expect(style).toMatch(/width:/);

    w.unmount();
    expect(document.body.querySelector('.tas__panel')).toBeNull();
  });

  it('stays open when the click lands inside the teleported panel', async () => {
    const w = mountReal();
    await w.get('.tas__trigger').trigger('click');
    const search = document.body.querySelector('.tas__search') as HTMLElement;
    expect(search).not.toBeNull();

    // The document-level outside-click handler no longer sees the panel as
    // part of the component, so typing in the search box closed the list
    // under the pointer unless the panel is excused explicitly.
    search.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(document.body.querySelector('.tas__panel')).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(document.body.querySelector('.tas__panel')).toBeNull();
    w.unmount();
  });
});
