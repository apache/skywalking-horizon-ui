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
 * The OTLP row's service layer: written upper-cased, never written while it is
 * not a layer name, cleared with the field, and kept through every other edit,
 * since a store whose only setting is its layer is still a configured store.
 */

import { describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { TracesConfig } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import TraceStoresEditor from './TraceStoresEditor.vue';

function mountEditor(traces?: TracesConfig, layerKey?: string): VueWrapper {
  return mount(TraceStoresEditor, { props: { traces, layerKey }, global: { plugins: [i18n] } });
}

/** The OTLP row's "Use this layer" checkbox, when the editor offers one. */
const useThisLayer = (w: VueWrapper) =>
  row(w, ROW.traceqlOtlp).findAll('label.ts-field.check').find((l) => l.text().startsWith('Use this layer'));

/** Rows are in `TRACE_STORES` order; the OTLP row's text fields are menu name, service filter, service layer. */
const ROW = { native: 0, traceqlNative: 2, traceqlOtlp: 4 };
const LAYER_FIELD = 2;

const row = (w: VueWrapper, i: number) => w.findAll('.ts-item')[i]!;
const emitted = (w: VueWrapper): TracesConfig | undefined => {
  const events = w.emitted('update') as Array<[TracesConfig | undefined]> | undefined;
  return events?.[events.length - 1]?.[0];
};

describe('trace stores editor: service layer', () => {
  it('writes the layer the OTLP picker is narrowed to, upper-cased', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'] });
    await row(w, ROW.traceqlOtlp).findAll('input[type="text"]')[LAYER_FIELD]!.setValue(' otlp_general ');
    expect(emitted(w)).toEqual({
      sources: ['traceql-otlp'],
      stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } },
    });
  });

  it('keeps a store whose only setting is its layer through another edit', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
    await row(w, ROW.native).get('input[type="checkbox"]').trigger('change');
    expect(emitted(w)).toEqual({
      sources: ['native', 'traceql-otlp'],
      stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } },
    });
  });

  it('drops the layer when its field is cleared', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
    await row(w, ROW.traceqlOtlp).findAll('input[type="text"]')[LAYER_FIELD]!.setValue('');
    expect(emitted(w)).toEqual({ sources: ['traceql-otlp'] });
  });

  it('offers the layer on the OTLP row only, whose catalog carries it', () => {
    const w = mountEditor({ sources: ['traceql-native', 'traceql-otlp'] });
    expect(row(w, ROW.traceqlNative).findAll('input[type="text"]')).toHaveLength(2);
    expect(row(w, ROW.traceqlOtlp).findAll('input[type="text"]')).toHaveLength(3);
  });

  it('shows the text as typed and writes it only once it is a layer name', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
    const field = row(w, ROW.traceqlOtlp).findAll('input[type="text"]')[LAYER_FIELD]!;

    await field.setValue('otlp-');
    expect((field.element as HTMLInputElement).value).toBe('otlp-');
    expect(w.emitted('update')).toBeUndefined();
    expect(w.find('.ts-warn').exists()).toBe(true);

    await field.setValue('otlp_mesh');
    expect(emitted(w)?.stores).toEqual({ 'traceql-otlp': { serviceLayer: 'OTLP_MESH' } });
    expect(w.find('.ts-warn').exists()).toBe(false);
  });

  it('names the saved layer an invalid edit leaves in place', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
    await row(w, ROW.traceqlOtlp).findAll('input[type="text"]')[LAYER_FIELD]!.setValue('otlp-mesh');
    expect(w.find('.ts-warn').text()).toContain('OTLP_GENERAL');
  });

  it('drops what was being typed when the layer changes from outside', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
    const field = row(w, ROW.traceqlOtlp).findAll('input[type="text"]')[LAYER_FIELD]!;
    await field.setValue('otlp-mesh');

    await w.setProps({ traces: { sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_MESH' } } } });

    expect((field.element as HTMLInputElement).value).toBe('OTLP_MESH');
    expect(w.find('.ts-warn').exists()).toBe(false);
  });

  it('drops what was being typed when another block arrives with the same layer', async () => {
    const saved = { sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } } as TracesConfig;
    const w = mountEditor(saved);
    const field = row(w, ROW.traceqlOtlp).findAll('input[type="text"]')[LAYER_FIELD]!;
    await field.setValue('1bad');

    // A discard hands back the stored block, a new object holding the same layer.
    await w.setProps({ traces: JSON.parse(JSON.stringify(saved)) });

    expect((field.element as HTMLInputElement).value).toBe('OTLP_GENERAL');
    expect(w.find('.ts-warn').exists()).toBe(false);
  });

  it('tells the OTLP row its store knows layers, not that it has none', () => {
    const w = mountEditor({ sources: ['traceql-native', 'traceql-otlp'] });
    expect(row(w, ROW.traceqlNative).text()).toContain('no notion of a layer');
    expect(row(w, ROW.traceqlOtlp).text()).not.toContain('no notion of a layer');
    expect(row(w, ROW.traceqlOtlp).text()).toContain('result rows are never filtered');
  });

  it('keeps the text as typed when the change is its own', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'] });
    const field = row(w, ROW.traceqlOtlp).findAll('input[type="text"]')[LAYER_FIELD]!;
    // Typing fires input only; setValue would also fire the change a blur fires, which shows the value as written.
    (field.element as HTMLInputElement).value = 'otlp_mesh';
    await field.trigger('input');

    await w.setProps({ traces: emitted(w) });

    expect((field.element as HTMLInputElement).value).toBe('otlp_mesh');
    await field.trigger('change');
    expect((field.element as HTMLInputElement).value).toBe('OTLP_MESH');
  });

  it('warns only under a store the layer reads from', () => {
    const w = mountEditor({ sources: ['native'], stores: { 'traceql-otlp': { serviceLayer: '1BAD' } } });
    expect(w.find('.ts-warn').exists()).toBe(false);
  });

  it('offers the layer being edited as the service layer', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'] }, 'OTLP_GENERAL');
    const box = useThisLayer(w)!;
    expect(box.text()).toBe('Use this layer (OTLP_GENERAL)');
    expect((box.get('input').element as HTMLInputElement).checked).toBe(false);

    await box.get('input').setValue(true);
    expect(emitted(w)).toEqual({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
  });

  it('shows the box ticked while the saved layer is the edited one, and clears the layer when unticked', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } }, 'OTLP_GENERAL');
    const box = useThisLayer(w)!;
    expect((box.get('input').element as HTMLInputElement).checked).toBe(true);

    await box.get('input').setValue(false);
    expect(emitted(w)).toEqual({ sources: ['traceql-otlp'] });
  });

  it('leaves the box unticked for another layer, and offers none without a layer key', () => {
    const mesh = mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_MESH' } } }, 'MESH');
    expect((useThisLayer(mesh)!.get('input').element as HTMLInputElement).checked).toBe(false);
    expect(useThisLayer(mountEditor({ sources: ['traceql-otlp'] }))).toBeUndefined();
  });

  it('warns about a stored value that is not a layer name', () => {
    expect(mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: '1BAD' } } })
      .find('.ts-warn').exists()).toBe(true);
    expect(mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } })
      .find('.ts-warn').exists()).toBe(false);
  });
});
