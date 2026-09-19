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
 * The date field that replaced `<input type="datetime-local">`.
 *
 * Two things matter: it emits exactly what the native control emitted, so a
 * host keeps its parsing untouched, and its calendar follows HORIZON's locale
 * rather than the browser's — which is the whole reason it exists.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import DateTimeField from './DateTimeField.vue';

function mountField(modelValue: string | null, props: Record<string, unknown> = {}) {
  return mount(DateTimeField, { props: { modelValue, ...props }, global: { plugins: [i18n] } });
}
const emitted = (w: ReturnType<typeof mountField>) => {
  const e = w.emitted('update:modelValue') as string[][] | undefined;
  return e?.[e.length - 1]?.[0];
};

beforeEach(() => { i18n.global.locale.value = 'en'; });

describe('date-time field', () => {
  it('shows the model unambiguously, and keeps the model’s own shape', () => {
    const w = mountField('2026-03-04T05:06');
    // A space on screen, `T` on the wire — the native control's format.
    expect((w.get('.dtf-input').element as HTMLInputElement).value).toBe('2026-03-04 05:06');
  });

  it('commits only a date that exists', async () => {
    const w = mountField('');
    await w.get('.dtf-input').setValue('2026-02-31 10:00');
    expect(emitted(w)).toBeUndefined();
    await w.get('.dtf-input').setValue('2026-02-28 10:00');
    expect(emitted(w)).toBe('2026-02-28T10:00');
  });

  it('accepts what an operator is likely to paste', async () => {
    const w = mountField('');
    // `T` or a space, one-digit fields, seconds it does not need.
    for (const [typed, want] of [
      ['2026-03-04T05:06', '2026-03-04T05:06'],
      ['2026-3-4 5:06', '2026-03-04T05:06'],
      ['2026-03-04 05:06:42', '2026-03-04T05:06'],
    ]) {
      await w.get('.dtf-input').setValue(typed);
      expect(emitted(w), typed).toBe(want);
    }
  });

  it('clears to an empty string rather than a half-typed one', async () => {
    const w = mountField('2026-03-04T05:06');
    await w.get('.dtf-input').setValue('');
    expect(emitted(w)).toBe('');
  });

  it('draws its calendar in Horizon’s locale, not the browser’s', async () => {
    const w = mountField('2026-03-04T05:06');
    await w.get('.dtf-open').trigger('click');
    expect(document.querySelector('.dtf-month')?.textContent).toContain('March');
    i18n.global.locale.value = 'zh-CN';
    await w.vm.$nextTick();
    // The month name is the locale's, which is what the native control would
    // never do — it follows the browser's UI language instead.
    expect(document.querySelector('.dtf-month')?.textContent).toContain('3月');
    w.unmount();
  });

  it('keeps the time when a day is picked, and the day when a time is typed', async () => {
    const w = mountField('2026-03-04T05:06');
    await w.get('.dtf-open').trigger('click');
    const days = [...document.querySelectorAll('.dtf-day')] as HTMLElement[];
    const tenth = days.find((d) => !d.classList.contains('out') && d.textContent?.trim() === '10');
    tenth!.click();
    await w.vm.$nextTick();
    expect(emitted(w)).toBe('2026-03-10T05:06');
    w.unmount();
  });

  it('works in whole days when asked to', async () => {
    const w = mountField('2026-03-04', { mode: 'date' });
    expect((w.get('.dtf-input').element as HTMLInputElement).value).toBe('2026-03-04');
    await w.get('.dtf-open').trigger('click');
    // No time row: the range is days.
    expect(document.querySelector('.dtf-foot')).toBeNull();
    await w.get('.dtf-input').setValue('2026-03-09');
    expect(emitted(w)).toBe('2026-03-09');
    w.unmount();
  });

  it('starts the week where each language starts it', async () => {
    // CLDR: Sunday for English, Japanese, Korean and Portuguese; Monday for
    // German, Spanish, French and Simplified Chinese. Read from a table
    // because `Intl.Locale.weekInfo` is absent in the engines we ship to, and
    // its absence silently started every locale on Monday.
    const w = mountField('2026-03-04T05:06');
    await w.get('.dtf-open').trigger('click');
    const firstCol = () => document.querySelector('.dtf-week span')?.textContent;
    for (const [loc, want] of [['en', 'S'], ['ja', '日'], ['ko', '일'], ['pt', 'D'],
                               ['de', 'M'], ['es', 'L'], ['fr', 'L'], ['zh-CN', '一']] as const) {
      i18n.global.locale.value = loc;
      await w.vm.$nextTick();
      expect(firstCol(), loc).toBe(want);
    }
    w.unmount();
  });

  it('does not rewrite what is being typed, and commits only a whole value', async () => {
    // Typed a character at a time, `2026-09-1` parses as the 1st. Committing
    // and normalising that mid-word moved the cursor and corrupted the rest.
    const w = mountField('');
    const input = w.get('.dtf-input');
    await input.trigger('focus');
    for (const partial of ['2', '20', '202', '2026', '2026-', '2026-0', '2026-09', '2026-09-', '2026-09-1', '2026-09-19', '2026-09-19 ', '2026-09-19 1', '2026-09-19 10', '2026-09-19 10:', '2026-09-19 10:0']) {
      await input.setValue(partial);
      expect(emitted(w), partial).toBeUndefined();
      expect((input.element as HTMLInputElement).value, partial).toBe(partial);
    }
    await input.setValue('2026-09-19 10:00');
    expect(emitted(w)).toBe('2026-09-19T10:00');
  });

  it('takes null from a host that holds the pair that way', () => {
    const w = mountField(null);
    expect((w.get('.dtf-input').element as HTMLInputElement).value).toBe('');
  });
});
