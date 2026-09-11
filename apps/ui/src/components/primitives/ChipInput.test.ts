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
 * ChipInput turns what is typed into chips on Enter: values typed together,
 * separated by commas or whitespace, become one chip each; Backspace in the
 * empty field takes the last chip back into it; × removes one; a value the
 * caller refuses stays in the field with the reason under it. Enter never
 * submits anything.
 */

import { describe, expect, it } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import ChipInput from './ChipInput.vue';

function mountChips(initial: string[] = [], extra: Record<string, unknown> = {}) {
  const values = ref<string[]>([...initial]);
  const w = mount(
    defineComponent({
      setup() {
        return () =>
          h(ChipInput, {
            modelValue: values.value,
            'onUpdate:modelValue': (v: string[]) => { values.value = v; },
            ...extra,
          });
      },
    }),
    { global: { plugins: [i18n] } },
  );
  return { w, values };
}

describe('ChipInput', () => {
  it('commits values typed together as one chip each, and empties the field', async () => {
    const { w, values } = mountChips();
    await w.get('.chi__input').setValue('a,b  c');
    await w.get('.chi__input').trigger('keydown', { key: 'Enter' });

    expect(values.value).toEqual(['a', 'b', 'c']);
    expect((w.get('.chi__input').element as HTMLInputElement).value).toBe('');
  });

  it('does not commit a value twice', async () => {
    const { w, values } = mountChips(['a']);
    await w.get('.chi__input').setValue('a');
    await w.get('.chi__input').trigger('keydown', { key: 'Enter' });

    expect(values.value).toEqual(['a']);
  });

  it('takes the last chip back into the field on Backspace in an empty field', async () => {
    const { w, values } = mountChips(['a', 'b']);
    await w.get('.chi__input').trigger('keydown', { key: 'Backspace' });

    expect(values.value).toEqual(['a']);
    expect((w.get('.chi__input').element as HTMLInputElement).value).toBe('b');
  });

  it('removes one chip with its ×', async () => {
    const { w, values } = mountChips(['a', 'b', 'c']);
    await w.findAll('.chi__x')[1]!.trigger('click');

    expect(values.value).toEqual(['a', 'c']);
  });

  it('keeps a refused value in the field with the reason, and commits the rest', async () => {
    const { w, values } = mountChips([], {
      normalize: (v: string) => (/^[a-z]+$/.test(v) ? v : null),
      invalidMessage: (v: string) => `not a word: ${v}`,
    });
    await w.get('.chi__input').setValue('ok 12 fine');
    await w.get('.chi__input').trigger('keydown', { key: 'Enter' });

    expect(values.value).toEqual(['ok', 'fine']);
    expect((w.get('.chi__input').element as HTMLInputElement).value).toBe('12');
    expect(w.get('.chi__refusal').text()).toBe('not a word: 12');
  });

  it('does nothing on Enter in an empty field — it never submits a query', async () => {
    const { w, values } = mountChips(['a']);
    await w.get('.chi__input').trigger('keydown', { key: 'Enter' });

    expect(values.value).toEqual(['a']);
    expect(w.findComponent(ChipInput).emitted()).not.toHaveProperty('submit');
  });
});
