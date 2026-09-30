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

import { beforeEach, describe, expect, it } from 'vitest';
import type { UITemplateClient, UITemplateRow } from '@skywalking-horizon-ui/api-client';
import { buildEnvelope, serializeEnvelope } from '../templates/names.js';
import { invalidateSyncCache } from '../templates/sync.js';
import { overviewExpressionsForLayer } from './effective.js';

const overview = {
  id: 'services',
  title: 'Services',
  widgets: [
    { id: 'w1', type: 'metric', layer: 'GENERAL', mqe: 'avg(top_n(service_cpm,{{topn}},DES))' },
    { id: 'w2', type: 'kpi-tile', layer: 'general', kpis: [{ label: 'SLA', mqe: 'avg(top_n(service_sla,{{topn}},DES))' }] },
    { id: 'w3', type: 'metric', layer: 'MESH', mqe: 'avg(top_n(service_resp_time,{{topn}},DES))' },
    { id: 'w4', type: 'metric', layer: 'GENERAL[payments]', mqe: 'avg(top_n(service_apdex,{{topn}},DES))' },
  ],
};

const client = (): UITemplateClient =>
  ({
    list: async (): Promise<UITemplateRow[]> => [
      { id: 'o1', disabled: false, configuration: serializeEnvelope(buildEnvelope('overview', 'services', overview)) } as UITemplateRow,
    ],
    create: () => Promise.reject(new Error('read only')),
    update: () => Promise.reject(new Error('read only')),
    disable: () => Promise.reject(new Error('read only')),
  }) as unknown as UITemplateClient;

beforeEach(() => invalidateSyncCache());

describe('the layer-wide expressions a stored overview declares', () => {
  it('collects widget and KPI expressions for the layer, case-folded, its group entries included', async () => {
    const got = await overviewExpressionsForLayer(client, 'GENERAL');
    expect([...got].sort()).toEqual([
      'avg(top_n(service_apdex,{{topn}},DES))',
      'avg(top_n(service_cpm,{{topn}},DES))',
      'avg(top_n(service_sla,{{topn}},DES))',
    ]);
  });

  it('declares nothing for a layer no overview reads, nor without a template store', async () => {
    expect((await overviewExpressionsForLayer(client, 'BANYANDB')).size).toBe(0);
    expect((await overviewExpressionsForLayer(undefined, 'GENERAL')).size).toBe(0);
  });
});
