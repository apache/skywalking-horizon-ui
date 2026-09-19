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
 * The long-value viewer. The value it COPIES is the whole one — a copy that
 * handed back the truncated text would be worse than no copy at all, since
 * what lands in the paste looks complete.
 */

import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import LongValue from './LongValue.vue';

const LONG = 'select * from songs where id in (' + '1, '.repeat(200) + '1)';

function mountValue(value: string, limit?: number) {
  return mount(LongValue, {
    props: { value, label: 'db.statement', ...(limit === undefined ? {} : { limit }) },
    global: { plugins: [i18n] },
  });
}

describe('long value', () => {
  it('renders a short value as itself, with nothing to open', () => {
    const w = mountValue('GET');
    expect(w.get('.lv-text').text()).toBe('GET');
    expect(w.find('.lv-more').exists()).toBe(false);
  });

  it('cuts a long value and offers the whole one', async () => {
    const w = mountValue(LONG);
    const shown = w.get('.lv-text').text();
    expect(LONG.startsWith(shown)).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(100);
    expect(shown.length).toBeGreaterThan(90);
    expect(w.find('.lv-more').exists()).toBe(true);
    await w.get('.lv-more').trigger('click');
    // The dialog is teleported to the body, and carries the value in full.
    expect(document.body.textContent).toContain(`${LONG.length} characters`);
    expect(document.querySelector('.lv-full')?.textContent).toBe(LONG);
    w.unmount();
  });

  it('treats a multi-line value as long, however short', async () => {
    const w = mountValue('line one\nline two');
    // One line on screen, both lines readable — the break becomes a space.
    expect(w.get('.lv-text').text()).toBe('line one line two');
    expect(w.find('.lv-more').exists()).toBe(true);
    // It fits once collapsed, so nothing was cut and nothing claims otherwise.
    expect(w.find('.lv-ellipsis').exists()).toBe(false);
  });

  it('previews a pretty-printed payload past its opening bracket', () => {
    // Stopping at the first newline would preview `[` and nothing else, which
    // is what an LLM request body looks like on a span.
    const body = JSON.stringify([{ role: 'system', content: 'x'.repeat(400) }], null, 2);
    const w = mountValue(body);
    const shown = w.get('.lv-text').text();
    expect(shown.length).toBe(100);
    expect(shown).toContain('"role": "system"');
  });

  it('copies the whole value, not the part on screen', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const w = mountValue(LONG);
    await w.get('.lv-more').trigger('click');
    document.querySelector<HTMLButtonElement>('.lv-dialog-bar .sw-btn')!.click();
    expect(writeText).toHaveBeenCalledWith(LONG);
    vi.unstubAllGlobals();
    w.unmount();
  });
});
