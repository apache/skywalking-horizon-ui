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

import { describe, expect, it } from 'vitest';
import type { AdminLayerTemplate } from '@/api/client';
import type { RolePairMetrics } from '@skywalking-horizon-ui/api-client';
import { cleanLayerTemplate } from './cleanLayerTemplate';
import { dropFromPrimary, renameInPrimary } from './pairPrimary';

function layer(extra: Record<string, unknown> = {}): AdminLayerTemplate {
  return {
    key: 'GENERAL',
    components: { service: true },
    metrics: {},
    widgets: [],
    dashboards: { service: [{ id: 'w1', title: 'Load', type: 'line', expressions: ['service_cpm'] }] },
    ...extra,
  } as unknown as AdminLayerTemplate;
}
const widget = (tpl: AdminLayerTemplate) => tpl.dashboards!.service![0]! as unknown as Record<string, unknown>;

describe('cleanLayerTemplate — what a save writes', () => {
  it('migrates the old single profiling flag', () => {
    const tpl = layer({ components: { service: true, profiling: true } });
    cleanLayerTemplate(tpl, null);
    expect(tpl.components).toEqual({ service: true, traceProfiling: true });
  });

  it('drops the label of a component switched off, and keeps one whose flag is absent', () => {
    const tpl = layer({
      components: { service: true, topology: false },
      slots: { topology: 'Map', instances: 'Pods' },
      aliases: { topology: 'Map' },
    });
    cleanLayerTemplate(tpl, null);
    expect(tpl.slots).toEqual({ instances: 'Pods' });
    // Emptied, but kept: an empty `slots` still overrides `aliases`.
    expect((tpl as unknown as { aliases: object }).aliases).toEqual({});
  });

  it('keeps the entity nouns with their pages off: other views still use them', () => {
    const tpl = layer({
      components: { service: false, instances: false, endpoints: false },
      slots: { services: 'Pods', instances: 'Containers', endpoints: 'Routes' },
    });
    cleanLayerTemplate(tpl, null);
    expect(tpl.slots).toEqual({ services: 'Pods', instances: 'Containers', endpoints: 'Routes' });
  });

  it('strips an empty deployment block and its menu entry', () => {
    const tpl = layer({ deployment: { nodeMetrics: [] }, menuOrder: ['service', 'deployment'] });
    cleanLayerTemplate(tpl, null);
    expect('deployment' in tpl).toBe(false);
    expect(tpl.menuOrder).toEqual(['service']);
  });

  it('drops a page condition with no attribute, and the list once it is empty', () => {
    const tpl = layer({
      dashboardExtPages: {
        instance: [{ id: 'jvm', name: 'JVM', widgets: [], instanceAttributes: [{ attribute: ' ', op: 'exists' }] }],
      },
      dashboardDefaultFilters: {
        instance: { instanceAttributes: [{ attribute: '', op: 'exists' }, { attribute: 'language', op: 'exists' }] },
      },
    });
    cleanLayerTemplate(tpl, null);
    expect('instanceAttributes' in tpl.dashboardExtPages!.instance![0]!).toBe(false);
    expect(tpl.dashboardDefaultFilters!.instance!.instanceAttributes).toEqual([{ attribute: 'language', op: 'exists' }]);
  });

  it('removes an empty Instance grid the edit created, and keeps one the template began with', () => {
    const added = layer({ dashboards: { service: [], instance: [], trace: [] } });
    cleanLayerTemplate(added, layer());
    expect(Object.keys(added.dashboards!)).toEqual(['service']);

    // An imported file that leaves the Instance page empty on purpose.
    const imported = layer({ dashboards: { service: [], instance: [] } });
    const kept = layer({ dashboards: { service: [], instance: [] } });
    cleanLayerTemplate(kept, imported);
    expect(kept.dashboards!.instance).toEqual([]);
  });

  it('cleans each widget: legacy gate and coordinates, a value map without enum, cleared numbers', () => {
    const tpl = layer();
    Object.assign(widget(tpl), {
      visibleWhen: 'service_cpm has value',
      format: 'int',
      valueMap: { '1': 'OK' },
      valueColors: { '1': 'ok' },
      x: 0,
      y: 0,
      w: 8,
      h: 16,
      rowSpan: '',
    });
    cleanLayerTemplate(tpl, null);
    expect(widget(tpl)).toEqual({
      id: 'w1',
      title: 'Load',
      type: 'line',
      expressions: ['service_cpm'],
      format: 'int',
      span: 4,
      rowSpan: 2,
    });
  });

  it('converts a legacy height within the row span the push accepts', () => {
    const tpl = layer();
    Object.assign(widget(tpl), { w: 60, h: 600 });
    cleanLayerTemplate(tpl, null);
    expect(widget(tpl)).toMatchObject({ span: 12, rowSpan: 64 });
  });

  it('keeps an enum card its value map', () => {
    const tpl = layer();
    Object.assign(widget(tpl), { type: 'card', format: 'enum', valueMap: { '1': 'OK' } });
    cleanLayerTemplate(tpl, null);
    expect(widget(tpl).valueMap).toEqual({ '1': 'OK' });
  });

  it('cleans thresholds: cleared numbers, and an invert base under an explicit no-invert', () => {
    const tpl = layer({
      topology: {
        nodeMetrics: [{ id: 'sla', label: 'SLA', mqe: 'service_sla', thresholds: { ok: '', warn: 1, invertHealth: false, invertBase: 100 } }],
        linkServerMetrics: [{ id: 'cpm', label: 'CPM', mqe: 'x', thresholds: { ok: 1, invertBase: 100 } }],
      },
    });
    cleanLayerTemplate(tpl, null);
    expect(tpl.topology!.nodeMetrics[0]!.thresholds).toEqual({ warn: 1, invertHealth: false });
    // With no explicit invert, the heuristic may still read the base.
    expect(tpl.topology!.linkServerMetrics![0]!.thresholds).toEqual({ ok: 1, invertBase: 100 });
  });
});

describe('a role pair primary follows its metrics', () => {
  it('carries a rename, in a single id or a list', () => {
    const one: RolePairMetrics = { from: '*', to: '*', primary: 'write', metrics: [] };
    renameInPrimary(one, 'write', 'writes');
    expect(one.primary).toBe('writes');
    const many: RolePairMetrics = { from: '*', to: '*', primary: ['write', 'query'], metrics: [] };
    renameInPrimary(many, 'query', 'reads');
    expect(many.primary).toEqual(['write', 'reads']);
  });

  it('lists an id once when a rename lands on one already listed', () => {
    const p: RolePairMetrics = { from: '*', to: '*', primary: ['write', 'read'], metrics: [] };
    renameInPrimary(p, 'write', 'read');
    expect(p.primary).toBe('read');
  });

  it('drops a removed metric, and the field once nothing is left', () => {
    const p: RolePairMetrics = { from: '*', to: '*', primary: ['write', 'query'], metrics: [] };
    dropFromPrimary(p, 'write');
    expect(p.primary).toBe('query');
    dropFromPrimary(p, 'query');
    expect('primary' in p).toBe(false);
  });
});
