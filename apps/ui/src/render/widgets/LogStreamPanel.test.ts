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

import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { LogRow } from '@/api/client';
import { i18n } from '@/i18n';
import LogStreamPanel from './LogStreamPanel.vue';
import LogOpenModeToggle from './LogOpenModeToggle.vue';
import { useLogOpenMode } from './useLogOpenMode';

const STACK = 'java.lang.IllegalStateException: boom\n\n\tat com.example.Svc.call(Svc.java:42)\n\tat com.example.Ctl.handle(Ctl.java:7)';

function row(i: number, over: Partial<LogRow> = {}): LogRow {
  return {
    serviceName: 'mesh-svr::frontend', serviceId: 's', serviceInstanceName: 'pod-1', serviceInstanceId: 'i',
    endpointName: null, endpointId: null, traceId: i === 0 ? 'trace-0' : null, timestamp: 1788393600000 + i,
    contentType: 'TEXT', content: STACK, tags: [{ key: 'level', value: 'ERROR' }],
    ...over,
  };
}

function mountPanel(rows: LogRow[]) {
  return mount(LogStreamPanel, { props: { rows }, attachTo: document.body, global: { plugins: [i18n] } });
}

afterEach(() => {
  useLogOpenMode().value = 'inline';
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe('LogStreamPanel', () => {
  it('expands a clicked row in place, keeps several open, and folds on a second click', async () => {
    const w = mountPanel([row(0), row(1)]);
    const rows = w.findAll('.lg-row');
    await rows[0].trigger('click');
    await rows[1].trigger('click');
    expect(w.findAll('.lg-expand')).toHaveLength(2);
    expect(rows[0].attributes('aria-expanded')).toBe('true');
    expect(w.find('.lg-expand-body').text()).toBe(STACK);
    expect(w.find('.lg-expand-meta').text()).toContain('pod-1');
    expect(w.find('.lg-expand-meta').text()).not.toContain('level=');
    expect(w.find('.lg-expand-tags').text()).toBe('level=ERROR');
    await rows[0].trigger('click');
    expect(w.findAll('.lg-expand')).toHaveLength(1);
    w.unmount();
  });

  it('folds an open row on one click anywhere in it, but not from Pop out', async () => {
    const w = mountPanel([row(0)]);
    await w.find('.lg-row').trigger('click');
    await w.find('.lg-popout').trigger('click');
    expect(w.find('.lg-expand').exists()).toBe(true);
    await w.find('.lg-expand-body').trigger('click');
    expect(w.find('.lg-expand').exists()).toBe(false);
    w.unmount();
  });

  it('leaves the row as it is when the click ends a text selection inside it', async () => {
    const w = mountPanel([row(0), row(1)]);
    const range = document.createRange();
    range.selectNodeContents(w.find('.lg-content-body').element);
    window.getSelection()!.addRange(range);
    await w.findAll('.lg-row')[0].trigger('click');
    expect(w.find('.lg-expand').exists()).toBe(false);
    window.getSelection()!.removeAllRanges();

    // Copying from the expanded body does not fold it either.
    await w.findAll('.lg-row')[0].trigger('click');
    const body = document.createRange();
    body.selectNodeContents(w.find('.lg-expand-body').element);
    window.getSelection()!.addRange(body);
    await w.find('.lg-expand-body').trigger('click');
    expect(w.find('.lg-expand').exists()).toBe(true);
    window.getSelection()!.removeAllRanges();
    await w.findAll('.lg-row')[0].trigger('click');
    // A selection in another row does not hold this one shut.
    await w.findAll('.lg-row')[1].trigger('click');
    expect(w.findAll('.lg-row')[1].attributes('aria-expanded')).toBe('true');
    w.unmount();
  });

  it('jumps to the trace from the chip without toggling the row', async () => {
    const w = mountPanel([row(0)]);
    await w.find('.lg-trace').trigger('click');
    expect(w.emitted('jump-trace')).toEqual([[{ traceId: 'trace-0', ts: 1788393600000 }]]);
    expect(w.find('.lg-expand').exists()).toBe(false);
    w.unmount();
  });

  it('hands the row to the host from Pop out', async () => {
    const rows = [row(0)];
    const w = mountPanel(rows);
    await w.find('.lg-row').trigger('click');
    await w.find('.lg-popout').trigger('click');
    const open = w.emitted('open') as Array<[{ row: LogRow; key: string }]>;
    expect(open).toHaveLength(1);
    expect(open[0][0].row).toEqual(rows[0]);
    expect(open[0][0].key).toBe('1788393600000-trace-0-0');
    w.unmount();
  });

  it('closes every open row when the rows change', async () => {
    const w = mountPanel([row(0), row(1)]);
    await w.findAll('.lg-row')[1].trigger('click');
    await w.setProps({ rows: [row(5), row(6)] });
    expect(w.find('.lg-expand').exists()).toBe(false);
    w.unmount();
  });

  it('opens the popout straight from a row click when the viewer picks Pop out', async () => {
    const toggle = mount(LogOpenModeToggle, { global: { plugins: [i18n] } });
    const rows = [row(0), row(1)];
    const w = mountPanel(rows);
    await w.findAll('.lg-row')[1].trigger('click');
    expect(w.find('.lg-expand').exists()).toBe(true);

    await toggle.findAll('button')[1].trigger('click');
    await nextTick();
    expect(localStorage.getItem('horizon:log-open-mode')).toBe('popout');
    // Switching mode folds what Inline had open.
    expect(w.find('.lg-expand').exists()).toBe(false);

    await w.findAll('.lg-row')[0].trigger('click');
    const open = w.emitted('open') as Array<[{ row: LogRow; key: string }]>;
    expect(open).toHaveLength(1);
    expect(open[0][0].row).toEqual(rows[0]);
    expect(w.find('.lg-expand').exists()).toBe(false);
    expect(w.findAll('.lg-row')[0].attributes('aria-expanded')).toBeUndefined();

    await toggle.findAll('button')[0].trigger('click');
    await nextTick();
    expect(localStorage.getItem('horizon:log-open-mode')).toBeNull();
    toggle.unmount();
    w.unmount();
  });

  it('keeps a row shut in Pop out mode when the click ends a text selection', async () => {
    useLogOpenMode().value = 'popout';
    const w = mountPanel([row(0)]);
    const range = document.createRange();
    range.selectNodeContents(w.find('.lg-content-body').element);
    window.getSelection()!.addRange(range);
    await w.find('.lg-row').trigger('click');
    expect(w.emitted('open')).toBeUndefined();
    w.unmount();
  });
});
