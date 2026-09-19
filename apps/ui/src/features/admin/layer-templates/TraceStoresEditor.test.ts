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
 * What the trace-store checklist WRITES, which is the half a rendered page
 * cannot show. Three shapes matter to the push route and to the sidebar: an
 * empty checklist must leave no `traces` block at all, unchecking a store must
 * take its settings with it, and the legacy `source` enum must not survive an
 * edit — a template carrying both would have the checklist silently win.
 */

import { describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { TracesConfig } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import TraceStoresEditor from './TraceStoresEditor.vue';

function mountEditor(traces?: TracesConfig): VueWrapper {
  return mount(TraceStoresEditor, { props: { traces }, global: { plugins: [i18n] } });
}

/** Rows are in `TRACE_STORES` order: native, zipkin, traceql-native, traceql-zipkin. */
const ROW = { native: 0, zipkin: 1, traceqlNative: 2, traceqlZipkin: 3 };

const toggle = (w: VueWrapper, row: number) =>
  w.findAll('.ts-item')[row]!.get('input[type="checkbox"]').trigger('change');
const field = (w: VueWrapper, row: number, i: number) =>
  w.findAll('.ts-item')[row]!.findAll('input[type="text"]')[i]!;
/** The last config the editor emitted. */
const emitted = (w: VueWrapper): TracesConfig | undefined => {
  const events = w.emitted('update') as Array<[TracesConfig | undefined]> | undefined;
  return events?.[events.length - 1]?.[0];
};

describe('trace stores editor', () => {
  it('checks a store on and off', async () => {
    const w = mountEditor({ sources: ['zipkin'] });
    await toggle(w, ROW.traceqlNative);
    expect(emitted(w)).toEqual({ sources: ['zipkin', 'traceql-native'] });

    const w2 = mountEditor({ sources: ['traceql-native'] });
    await toggle(w2, ROW.traceqlNative);
    // An empty LIST, not an absent block: absence is compatibility — it reads
    // as the native store — so it cannot also mean "none".
    expect(emitted(w2)).toEqual({ sources: [] });
  });

  it('writes a row name and a service filter for the store they belong to', async () => {
    const w = mountEditor({ sources: ['traceql-native'] });
    await field(w, ROW.traceqlNative, 0).setValue('OTLP traces');
    expect(emitted(w)).toEqual({
      sources: ['traceql-native'],
      stores: { 'traceql-native': { name: 'OTLP traces' } },
    });
  });

  it('keeps the case flag beside the pattern', async () => {
    const w = mountEditor({ sources: ['traceql-native'] });
    await field(w, ROW.traceqlNative, 1).setValue('^agent::');
    // The editor is controlled — the parent writes each emitted config straight
    // back onto the draft — so a second edit must read the first one back.
    await w.setProps({ traces: emitted(w) });
    // `i` is the one flag offered, as a checkbox: the others are meaningless on
    // a service name or carry state between tests.
    await w.findAll('.ts-item')[ROW.traceqlNative]!.get('.ts-field.check input').setValue(true);
    expect(emitted(w)?.stores?.['traceql-native']?.serviceFilter).toEqual({
      pattern: '^agent::',
      flags: 'i',
    });
  });

  it('opens on what the layer resolves to, and writes it out on the first edit', async () => {
    // A template written before the checklist: silence means the native store,
    // and the legacy enum means the store it named. Both must be TICKED, or an
    // operator adding one store would silently drop the one already in effect.
    const silent = mountEditor(undefined);
    expect((silent.findAll('.ts-item')[ROW.native]!.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
    await toggle(silent, ROW.traceqlNative);
    expect(emitted(silent)?.sources).toEqual(['native', 'traceql-native']);

    const legacy = mountEditor({ source: 'zipkin' });
    expect((legacy.findAll('.ts-item')[ROW.zipkin]!.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
    await toggle(legacy, ROW.traceqlZipkin);
    expect(emitted(legacy)?.sources).toEqual(['zipkin', 'traceql-zipkin']);
    expect(emitted(legacy)?.source).toBeUndefined();
  });

  it('says none as an empty list, because an absent block means native', async () => {
    const w = mountEditor({ sources: ['native'] });
    await toggle(w, ROW.native);
    expect(emitted(w)).toEqual({ sources: [] });
  });

  it('drops a store’s settings when the store is unchecked', async () => {
    const w = mountEditor({
      sources: ['native', 'traceql-native'],
      stores: { 'traceql-native': { name: 'OTLP', serviceFilter: { pattern: '^a' } } },
    });
    await toggle(w, ROW.traceqlNative);
    // Settings for a row nobody can see are settings nobody remembers writing.
    expect(emitted(w)).toEqual({ sources: ['native'] });
  });

  it('replaces the legacy enum rather than editing alongside it', async () => {
    const w = mountEditor({ source: 'both' });
    await toggle(w, ROW.zipkin);
    const next = emitted(w);
    expect(next?.sources).toEqual(['native']);
    expect(next?.source).toBeUndefined();
  });

  it('says so when the pattern does not compile, and still stores it', async () => {
    const w = mountEditor({ sources: ['traceql-zipkin'] });
    await field(w, ROW.traceqlZipkin, 1).setValue('[unclosed');
    await w.setProps({ traces: emitted(w) });
    expect(w.find('.ts-warn').exists()).toBe(true);
    // Refusing to store it would lose the operator's half-typed expression;
    // the backend already treats a broken pattern as no filter.
    expect(emitted(w)?.stores?.['traceql-zipkin']?.serviceFilter?.pattern).toBe('[unclosed');
  });

  it('offers a service filter only where one applies', () => {
    const w = mountEditor({ sources: ['native', 'zipkin', 'traceql-native'] });
    expect(w.findAll('.ts-item')[ROW.native]!.findAll('input[type="text"]')).toHaveLength(1);
    expect(w.findAll('.ts-item')[ROW.zipkin]!.findAll('input[type="text"]')).toHaveLength(1);
    expect(w.findAll('.ts-item')[ROW.traceqlNative]!.findAll('input[type="text"]')).toHaveLength(2);
  });
});
