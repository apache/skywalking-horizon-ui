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
 * What the log-type choice WRITES: native is the absent `type`, so a template
 * names the type only when it is OTLP, and the rest of the `log` block is kept.
 */

import { describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { LogConfig } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import LogTypeEditor from './LogTypeEditor.vue';

function mountEditor(log?: LogConfig, readOnly = false): VueWrapper {
  return mount(LogTypeEditor, { props: { log, readOnly }, global: { plugins: [i18n] } });
}
const pick = (w: VueWrapper, type: 'native' | 'otlp') => w.get(`input[value="${type}"]`).trigger('change');
const emitted = (w: VueWrapper): Array<[LogConfig | undefined]> =>
  (w.emitted('update') as Array<[LogConfig | undefined]> | undefined) ?? [];

describe('log type editor', () => {
  it('shows native when the template names no type', () => {
    const w = mountEditor(undefined);
    expect((w.get('input[value="native"]').element as HTMLInputElement).checked).toBe(true);
    expect((w.get('input[value="otlp"]').element as HTMLInputElement).checked).toBe(false);
  });

  it('writes otlp, keeping the scope', async () => {
    const w = mountEditor({ scope: 'instance' });
    await pick(w, 'otlp');
    expect(emitted(w).at(-1)?.[0]).toEqual({ scope: 'instance', type: 'otlp' });
  });

  it('writes native as an absent type, and drops a block left empty', async () => {
    const scoped = mountEditor({ scope: 'instance', type: 'otlp' });
    await pick(scoped, 'native');
    expect(emitted(scoped).at(-1)?.[0]).toEqual({ scope: 'instance' });

    const bare = mountEditor({ type: 'otlp' });
    await pick(bare, 'native');
    expect(emitted(bare).at(-1)?.[0]).toBeUndefined();
    expect(emitted(bare)).toHaveLength(1);
  });

  it('writes nothing when read-only', async () => {
    const w = mountEditor({ type: 'otlp' }, true);
    await pick(w, 'native');
    expect(emitted(w)).toHaveLength(0);
  });
});
