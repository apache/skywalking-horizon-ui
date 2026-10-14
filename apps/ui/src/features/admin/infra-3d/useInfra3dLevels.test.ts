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
import { computed, ref } from 'vue';
import type { Infra3dConfig } from '@/api/client';
import { placeRowsByTier, useInfra3dLevels, type ResolvedLevel } from './useInfra3dLevels';

function config(): Infra3dConfig {
  const style = { color: '#fff', style: 'solid' as const, arrow: false };
  return {
    filter: { layer: '^(?!HIDDEN).*' },
    edges: { hierarchy: style, crossLevelCall: style, intraCall: style },
    pipeline: { metricChunkSize: 1, topologyConcurrency: 1, templateConcurrency: 1 },
    unknownLayer: { level: 'middleware', badge: 'unclassified' },
    levels: [
      { id: 'apps', order: 0, label: 'Apps', layers: ['GENERAL'] },
      { id: 'middleware', order: 1, label: 'Middleware', layers: ['MYSQL', 'SO11Y_OAP'] },
      { id: 'infra', order: 2, label: 'Infra', layers: ['K8S', 'HIDDEN_X'] },
    ],
    groups: [
      { id: 'so11y', label: 'Self-Observability', level: 'middleware', color: '#a78bfa', icon: 'svc', layers: ['SO11Y_OAP'] },
      { id: 'stores', label: 'Stores', level: 'infra', color: '#a78bfa', icon: 'db', layers: ['REDIS'] },
    ],
    layers: {},
  };
}

function setup(readOnly = false) {
  const draft = ref<Infra3dConfig | null>(config());
  const levels = useInfra3dLevels(draft, computed(() => readOnly));
  return { draft, ...levels };
}

describe('renameLevel', () => {
  it('carries the groups and the failover tier to the new id', () => {
    const { draft, renameLevel } = setup();
    expect(renameLevel('middleware', 'data')).toBe(true);
    const cfg = draft.value!;
    expect(cfg.levels.map((l) => l.id)).toEqual(['apps', 'data', 'infra']);
    expect(cfg.levels[1]!.layers).toEqual(['MYSQL', 'SO11Y_OAP']);
    expect(cfg.groups!.map((g) => g.level)).toEqual(['data', 'infra']);
    expect(cfg.unknownLayer.level).toBe('data');
  });

  it('keeps every reference through a rename typed one key at a time', () => {
    const { draft, renameLevel } = setup();
    let id = 'middleware';
    for (const next of ['middlewar', 'middlewa', 'middlewa-2', 'middleware-2']) {
      expect(renameLevel(id, next)).toBe(true);
      id = next;
    }
    expect(draft.value!.groups![0]!.level).toBe('middleware-2');
    expect(draft.value!.unknownLayer.level).toBe('middleware-2');
  });

  it('refuses another tier\'s id and an empty id, changing nothing', () => {
    const { draft, renameLevel } = setup();
    const before = JSON.stringify(draft.value);
    expect(renameLevel('middleware', 'infra')).toBe(false);
    expect(renameLevel('middleware', '')).toBe(false);
    expect(JSON.stringify(draft.value)).toBe(before);
  });

  it('continues from the last id it took after a refused keystroke', () => {
    const { draft, renameLevel } = setup();
    // "ap" → "apps" passes through the apps tier's id on the way to "apps-2".
    expect(renameLevel('middleware', 'ap')).toBe(true);
    expect(renameLevel('ap', 'apps')).toBe(false);
    expect(renameLevel('ap', 'apps-2')).toBe(true);
    const cfg = draft.value!;
    expect(cfg.levels.map((l) => l.id)).toEqual(['apps', 'apps-2', 'infra']);
    expect(cfg.groups![0]!.level).toBe('apps-2');
    expect(cfg.unknownLayer.level).toBe('apps-2');
  });

  it('changes nothing in a read-only session', () => {
    const { draft, renameLevel } = setup(true);
    expect(renameLevel('middleware', 'data')).toBe(false);
    expect(draft.value!.levels[1]!.id).toBe('middleware');
  });
});

describe('removeLevel', () => {
  it('moves the groups and the failover tier on the removed tier to the first remaining one', () => {
    const { draft, removeLevel } = setup();
    removeLevel('middleware');
    const cfg = draft.value!;
    expect(cfg.levels.map((l) => l.id)).toEqual(['apps', 'infra']);
    expect(cfg.groups!.map((g) => g.level)).toEqual(['apps', 'infra']);
    expect(cfg.unknownLayer.level).toBe('apps');
  });

  it('leaves references to other tiers alone', () => {
    const { draft, removeLevel } = setup();
    removeLevel('apps');
    expect(draft.value!.groups!.map((g) => g.level)).toEqual(['middleware', 'infra']);
    expect(draft.value!.unknownLayer.level).toBe('middleware');
  });

  it('keeps the last tier', () => {
    const { draft, removeLevel } = setup();
    removeLevel('apps');
    removeLevel('infra');
    removeLevel('middleware');
    expect(draft.value!.levels.map((l) => l.id)).toEqual(['middleware']);
    expect(draft.value!.groups!.map((g) => g.level)).toEqual(['middleware', 'middleware']);
    expect(draft.value!.unknownLayer.level).toBe('middleware');
  });
});

describe('placeRowsByTier', () => {
  const rows = ['GENERAL', 'MYSQL', 'SO11Y_OAP', 'REDIS', 'K8S', 'HIDDEN_X', 'UNKNOWN'].map((key) => ({ key }));

  function place(cfg: (c: Infra3dConfig) => void = () => undefined) {
    const { draft, resolveLevel } = setup();
    cfg(draft.value!);
    const resolved: Record<string, ResolvedLevel> = {};
    for (const r of rows) resolved[r.key] = resolveLevel(r.key);
    const out = placeRowsByTier(draft.value!.levels.map((l) => l.id), rows, resolved);
    const keys = (rs: { key: string }[]) => rs.map((r) => r.key);
    return {
      byTier: Object.fromEntries(Object.entries(out.byTier).map(([id, rs]) => [id, keys(rs)])),
      unplaced: keys(out.unplaced),
    };
  }

  it('files a grouped layer under its group\'s tier, whatever it is pinned to', () => {
    const out = place((c) => {
      c.groups![0]!.level = 'apps';
    });
    expect(out.byTier).toEqual({
      apps: ['GENERAL', 'SO11Y_OAP'],
      middleware: ['MYSQL'],
      infra: ['REDIS', 'K8S'],
    });
  });

  it('leaves failover and filtered-out layers unplaced', () => {
    expect(place().unplaced).toEqual(['HIDDEN_X', 'UNKNOWN']);
  });

  it('leaves a layer whose tier is missing unplaced rather than dropping it', () => {
    const out = place((c) => {
      c.groups![1]!.level = 'gone';
    });
    expect(out.unplaced).toEqual(['REDIS', 'HIDDEN_X', 'UNKNOWN']);
  });
});
