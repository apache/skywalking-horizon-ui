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
import type { Infra3dConfig } from '@/api/client';
import { addLayerToGroup, dropBlankMetrics, groupsByLayer, normalizeInfra3dDraft } from './infra3dDraft';

const metric = (mqe: string) => ({ mqe, label: 'calls', unit: 'cpm' });

function config(): Infra3dConfig {
  const style = { color: '#fff', style: 'solid' as const, arrow: false };
  return {
    filter: { layer: '.*' },
    edges: { hierarchy: style, crossLevelCall: style, intraCall: style },
    pipeline: { metricChunkSize: 1, topologyConcurrency: 1, templateConcurrency: 1 },
    unknownLayer: { level: 'middleware', badge: 'unclassified' },
    levels: [
      { id: 'apps', order: 0, label: 'Apps', layers: ['GENERAL'] },
      { id: 'middleware', order: 1, label: 'Middleware', layers: ['MYSQL', 'so11y_oap', 'REDIS'] },
    ],
    groups: [
      { id: 'so11y', label: 'Self-Observability', level: 'apps', color: '#a78bfa', icon: 'svc', layers: ['SO11Y_OAP'] },
      { id: 'empty', label: 'Empty', level: 'apps', color: '#a78bfa', icon: 'svc', layers: [] },
    ],
    layers: {
      GENERAL: { color: '#111', metric: metric('service_cpm') },
      MESH: { color: '#222', topology: { client: metric('client_cpm') }, load: metric('load') },
      MYSQL: { color: '#333', load: metric('mysql_qps') },
    },
  };
}

describe('normalizeInfra3dDraft', () => {
  it('folds the legacy metric shapes into `metric`', () => {
    const cfg = config();
    normalizeInfra3dDraft(cfg);
    expect(cfg.layers).toEqual({
      GENERAL: { color: '#111', metric: metric('service_cpm') },
      MESH: { color: '#222', metric: metric('client_cpm') },
      MYSQL: { color: '#333', metric: metric('mysql_qps') },
    });
  });

  it('drops the stored pipeline block', () => {
    const cfg = config();
    normalizeInfra3dDraft(cfg);
    expect('pipeline' in cfg).toBe(false);
  });

  it('drops the tier pin of a grouped layer and keeps the rest', () => {
    const cfg = config();
    normalizeInfra3dDraft(cfg);
    expect(cfg.levels.map((l) => l.layers)).toEqual([['GENERAL'], ['MYSQL', 'REDIS']]);
    expect(cfg.groups![0]!.layers).toEqual(['SO11Y_OAP']);
  });
});

describe('addLayerToGroup', () => {
  it('drops the layer\'s tier pin as it joins', () => {
    const cfg = config();
    addLayerToGroup(cfg, cfg.groups![1]!, 'redis');
    expect(cfg.groups![1]!.layers).toEqual(['REDIS']);
    expect(cfg.levels[1]!.layers).toEqual(['MYSQL', 'so11y_oap']);
    expect(groupsByLayer(cfg).REDIS?.id).toBe('empty');
  });

  it('refuses a layer another group already holds', () => {
    const cfg = config();
    addLayerToGroup(cfg, cfg.groups![1]!, 'SO11Y_OAP');
    expect(cfg.groups![1]!.layers).toEqual([]);
  });

  it('ignores an empty pick', () => {
    const cfg = config();
    addLayerToGroup(cfg, cfg.groups![1]!, '');
    expect(cfg.groups![1]!.layers).toEqual([]);
  });
});

describe('dropBlankMetrics', () => {
  it('drops a metric with every field blank and keeps one partly filled in', () => {
    const cfg = config();
    cfg.layers.GENERAL!.metric = { mqe: '', label: ' ', unit: '' };
    cfg.layers.MYSQL!.metric = { mqe: '', label: 'qps', unit: '' };
    dropBlankMetrics(cfg);
    expect(cfg.layers.GENERAL).toEqual({ color: '#111' });
    expect(cfg.layers.MYSQL!.metric).toEqual({ mqe: '', label: 'qps', unit: '' });
  });
});
