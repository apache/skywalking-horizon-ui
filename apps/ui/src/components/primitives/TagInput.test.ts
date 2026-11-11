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
 * TagInput with suggestions a host holds (the Zipkin and TraceQL tabs), and
 * the note a host raises over the field: gone after five seconds, on a click,
 * or as soon as the text it was about changes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, reactive, ref } from 'vue';
import { mount } from '@vue/test-utils';
import TagInput from './TagInput.vue';
import type { TagSuggestions } from './tagFilter';

function mountField(suggestions: TagSuggestions | null = null, extra: Record<string, unknown> = {}) {
  const text = ref('');
  const field = ref<InstanceType<typeof TagInput> | null>(null);
  const commits = ref(0);
  const w = mount(
    defineComponent({
      setup() {
        return () =>
          h(TagInput, {
            ref: field,
            modelValue: text.value,
            'onUpdate:modelValue': (v: string) => { text.value = v; },
            onCommit: () => { commits.value += 1; },
            suggestions,
            ...extra,
          });
      },
    }),
    { attachTo: document.body },
  );
  return { w, text, field, commits };
}

/** A host whose keys are `http.method` and `db.statement`, with fixed values. */
function hostSuggestions() {
  const loadValues = vi.fn();
  const values: Record<string, string[]> = {
    'http.method': ['GET', 'POST'],
    'db.statement': ['SELECT a, b', 'SELECT c'],
  };
  const s: TagSuggestions = { keys: ['http.method', 'db.statement'], valuesFor: (k) => values[k] ?? [], loadValues };
  return { s, loadValues };
}

async function typeAndSettle(input: ReturnType<ReturnType<typeof mountField>['w']['get']>, text: string): Promise<void> {
  await input.trigger('focus');
  await input.setValue(text);
  vi.advanceTimersByTime(200);
  await nextTick();
}

function rows(): string[] {
  return Array.from(document.body.querySelectorAll('.tgi__row-label')).map((el) => el.textContent ?? '');
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('TagInput with host suggestions', () => {
  it('offers the host keys, then asks the host for the values of the key typed', async () => {
    const values = reactive<Record<string, string[]>>({});
    const loadValues = vi.fn((key: string) => { values[key] = ['GET', 'POST']; });
    const { w } = mountField({ keys: ['http.method', 'http.url'], valuesFor: (k) => values[k] ?? [], loadValues });
    const input = w.get('input');

    await input.trigger('focus');
    await input.setValue('http.m');
    expect(rows()).toEqual(['http.method=']);

    vi.useFakeTimers();
    await input.setValue('http.method=');
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(loadValues).toHaveBeenCalledWith('http.method');
    expect(rows()).toEqual(['http.method=GET', 'http.method=POST']);
    w.unmount();
  });
});

describe('TagInput completion boundary', () => {
  it('completes the whole text by default, so a value may hold a comma', async () => {
    vi.useFakeTimers();
    const { s, loadValues } = hostSuggestions();
    const { w } = mountField(s);
    await typeAndSettle(w.get('input'), 'db.statement=SELECT a,');
    expect(loadValues).toHaveBeenLastCalledWith('db.statement');
    expect(rows()).toEqual(['db.statement=SELECT a, b']);
    w.unmount();
  });

  it('completes the term after the last separator, and keeps the terms before it', async () => {
    vi.useFakeTimers();
    const { s, loadValues } = hostSuggestions();
    const { w, text } = mountField(s, { separator: ' and ' });
    await typeAndSettle(w.get('input'), 'error and http.method=G');
    expect(loadValues).toHaveBeenLastCalledWith('http.method');
    expect(rows()).toEqual(['http.method=GET']);

    await document.body.querySelector<HTMLElement>('.tgi__row')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await nextTick();
    expect(text.value).toBe('error and http.method=GET');
    w.unmount();
  });

  it('still reads a comma list when the host says so', async () => {
    vi.useFakeTimers();
    const { s } = hostSuggestions();
    const { w } = mountField(s, { separator: ',' });
    await typeAndSettle(w.get('input'), 'http.method=GET, db.');
    expect(rows()).toEqual(['db.statement=']);
    w.unmount();
  });
});

describe('TagInput during IME composition', () => {
  it('leaves Enter to the IME rather than committing the half-composed text', async () => {
    const { w, commits } = mountField();
    const input = w.get('input');
    await input.setValue('标签');
    await input.trigger('keydown', { key: 'Enter', isComposing: true });
    await input.trigger('keydown', { key: 'Enter', keyCode: 229 });
    expect(commits.value).toBe(0);

    await input.trigger('keydown', { key: 'Enter' });
    expect(commits.value).toBe(1);
    w.unmount();
  });
});

describe('TagInput note', () => {
  it('shows the note under the field and clears it after five seconds', async () => {
    vi.useFakeTimers();
    const { w, field } = mountField();
    field.value?.notify('Not included', 'warn');
    await nextTick();
    expect(w.get('.tgi__note').text()).toBe('Not included');
    expect(w.get('.tgi__note').classes()).toContain('tgi__note--warn');

    vi.advanceTimersByTime(4999);
    await nextTick();
    expect(w.find('.tgi__note').exists()).toBe(true);
    vi.advanceTimersByTime(1);
    await nextTick();
    expect(w.find('.tgi__note').exists()).toBe(false);
    w.unmount();
  });

  it('clears the note on a click, which goes back to the field', async () => {
    const { w, field } = mountField();
    field.value?.notify('Not included', 'warn');
    await nextTick();

    await w.get('.tgi__note').trigger('mousedown');
    expect(w.find('.tgi__note').exists()).toBe(false);
    expect(document.activeElement).toBe(w.get('input').element);
    w.unmount();
  });

  it('clears the note as soon as the text changes', async () => {
    const { w, field } = mountField();
    field.value?.notify('Not a tag', 'err');
    await nextTick();
    expect(w.get('.tgi__note').classes()).toContain('tgi__note--err');

    await w.get('input').setValue('a=b');
    expect(w.find('.tgi__note').exists()).toBe(false);
    w.unmount();
  });
});
