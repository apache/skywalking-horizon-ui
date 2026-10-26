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
 * The OTLP row's service layer: picked from the layers OAP stores OTLP services
 * under, cleared with "All layers", kept through every other edit, since a store whose
 * only setting is its layer is still a configured store, and set to the
 * dashboard's own layer by "Use dashboard layer".
 */

import { describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { TracesConfig } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import TraceStoresEditor from './TraceStoresEditor.vue';

function mountEditor(traces?: TracesConfig, layerKey?: string): VueWrapper {
  return mount(TraceStoresEditor, { props: { traces, layerKey }, global: { plugins: [i18n] } });
}

/** Rows are in `TRACE_STORES` order. */
const ROW = { native: 0, traceqlNative: 2, traceqlOtlp: 4 };

const row = (w: VueWrapper, i: number) => w.findAll('.ts-item')[i]!;
const layerSelect = (w: VueWrapper) => row(w, ROW.traceqlOtlp).find('select');
const options = (w: VueWrapper) => layerSelect(w).findAll('option').map((o) => o.element.value);
const emitted = (w: VueWrapper): TracesConfig | undefined => {
  const events = w.emitted('update') as Array<[TracesConfig | undefined]> | undefined;
  return events?.[events.length - 1]?.[0];
};
/** The OTLP row's "Use dashboard layer" checkbox, when the editor offers one. */
const useDashboardLayer = (w: VueWrapper) =>
  row(w, ROW.traceqlOtlp).findAll('label.ts-field.check').find((l) => l.text().startsWith('Use dashboard layer'));

describe('trace stores editor: service layer', () => {
  it('lays a TraceQL row out in three rows, the layer on the OTLP one only', () => {
    const w = mountEditor({ sources: ['traceql-native', 'traceql-otlp'] });
    expect(row(w, ROW.traceqlOtlp).findAll('.ts-row')).toHaveLength(3);
    expect(row(w, ROW.traceqlNative).findAll('.ts-row')).toHaveLength(2);
    expect(row(w, ROW.traceqlNative).find('select').exists()).toBe(false);
  });

  it('offers the layers OAP stores OTLP services under, after All layers', () => {
    const w = mountEditor({ sources: ['traceql-otlp'] });
    expect(options(w)).toEqual(['', 'OTLP_GENERAL', 'OTLP_MESH', 'UNDEFINED']);
    expect(layerSelect(w).findAll('option')[0]!.text()).toBe('All layers');
  });

  it('writes the layer picked', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'] });
    await layerSelect(w).setValue('OTLP_MESH');
    expect(emitted(w)).toEqual({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_MESH' } } });
  });

  it('drops the layer when All layers is picked', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
    expect((layerSelect(w).element as HTMLSelectElement).value).toBe('OTLP_GENERAL');
    await layerSelect(w).setValue('');
    expect(emitted(w)).toEqual({ sources: ['traceql-otlp'] });
  });

  it('keeps a store whose only setting is its layer through another edit', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
    await row(w, ROW.native).get('input[type="checkbox"]').trigger('change');
    expect(emitted(w)).toEqual({
      sources: ['native', 'traceql-otlp'],
      stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } },
    });
  });

  it('shows a saved layer that is not among the options as one more', () => {
    const w = mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'MESH' } } });
    expect(options(w)).toEqual(['', 'OTLP_GENERAL', 'OTLP_MESH', 'UNDEFINED', 'MESH']);
    expect((layerSelect(w).element as HTMLSelectElement).value).toBe('MESH');
  });

  it('tells the OTLP row its store knows layers, not that it has none', () => {
    const w = mountEditor({ sources: ['traceql-native', 'traceql-otlp'] });
    expect(row(w, ROW.traceqlNative).text()).toContain('no notion of a layer');
    expect(row(w, ROW.traceqlOtlp).text()).not.toContain('no notion of a layer');
    expect(row(w, ROW.traceqlOtlp).text()).toContain('result rows are never filtered');
  });

  it('offers the dashboard layer being edited as the service layer', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'] }, 'OTLP_GENERAL');
    const box = useDashboardLayer(w)!;
    expect(box.text()).toBe('Use dashboard layer (OTLP_GENERAL)');
    expect((box.get('input').element as HTMLInputElement).checked).toBe(false);

    await box.get('input').setValue(true);
    expect(emitted(w)).toEqual({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
  });

  it('shows the box ticked while the saved layer is the edited one, and clears the layer when unticked', async () => {
    const w = mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } }, 'OTLP_GENERAL');
    const box = useDashboardLayer(w)!;
    expect((box.get('input').element as HTMLInputElement).checked).toBe(true);

    await box.get('input').setValue(false);
    expect(emitted(w)).toEqual({ sources: ['traceql-otlp'] });
  });

  it('leaves the box unticked for another layer, and offers none without a layer key', () => {
    const mesh = mountEditor({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_MESH' } } }, 'MESH');
    expect((useDashboardLayer(mesh)!.get('input').element as HTMLInputElement).checked).toBe(false);
    expect(useDashboardLayer(mountEditor({ sources: ['traceql-otlp'] }))).toBeUndefined();
  });
});
