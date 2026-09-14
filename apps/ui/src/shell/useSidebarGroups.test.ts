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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, shallowRef, type EffectScope } from 'vue';
import { useRoute } from 'vue-router';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { buildSidebarEntries, type SidebarEntry } from './sidebarEntries';
import { useSidebarGroups } from './useSidebarGroups';

vi.mock('vue-router', () => ({ useRoute: vi.fn() }));

const route = reactive({ path: '/', fullPath: '/', params: {} });
const scopes: EffectScope[] = [];

function navigate(path: string): void {
  route.path = path;
  route.fullPath = path;
  route.params = { layerKey: path.match(/^\/layer\/([^/]+)/)?.[1] };
}

function layer(key: string, group?: string): LayerDef {
  return {
    key,
    name: key,
    group,
    color: '#fff',
    serviceCount: 1,
    active: true,
    level: null,
    slots: {},
    caps: { dashboards: true },
  };
}

const mq = layer('ACTIVEMQ', 'MQ');
const kafka = layer('KAFKA', 'MQ');
const ai = layer('AI_AGENT');
const mysql = layer('MYSQL', 'Databases');
const postgres = layer('POSTGRESQL', 'Databases');
const menu = [mq, kafka, ai, mysql, postgres];

function setup(rows: readonly LayerDef[] = menu) {
  const entries = shallowRef<readonly SidebarEntry[]>(buildSidebarEntries(rows));
  const scope = effectScope();
  scopes.push(scope);
  const groups = scope.run(() => useSidebarGroups(entries))!;
  return { entries, ...groups };
}

beforeEach(() => {
  navigate('/overview');
  vi.mocked(useRoute).mockReturnValue(route as ReturnType<typeof useRoute>);
});

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  vi.clearAllMocks();
});

describe('useSidebarGroups', () => {
  it('starts groups open and toggles each group independently', () => {
    const { isGroupOpen, toggleGroup } = setup();

    expect(isGroupOpen('MQ')).toBe(true);
    expect(isGroupOpen('Databases')).toBe(true);

    toggleGroup('MQ');
    expect(isGroupOpen('MQ')).toBe(false);
    expect(isGroupOpen('Databases')).toBe(true);

    toggleGroup('Databases');
    toggleGroup('MQ');
    expect(isGroupOpen('MQ')).toBe(true);
    expect(isGroupOpen('Databases')).toBe(false);
  });

  it('opens the containing group on case-insensitive navigation and leaves other groups collapsed', async () => {
    const { isGroupOpen, toggleGroup } = setup();
    toggleGroup('MQ');
    toggleGroup('Databases');

    navigate('/layer/activemq/service');
    await nextTick();

    expect(isGroupOpen('MQ')).toBe(true);
    expect(isGroupOpen('Databases')).toBe(false);
  });

  it('reopens a manually collapsed active group when navigating within that group', async () => {
    navigate('/layer/activemq/service');
    const { isGroupOpen, toggleGroup } = setup();
    expect(isGroupOpen('MQ')).toBe(true);

    toggleGroup('MQ');
    navigate('/layer/activemq/instance');
    await nextTick();
    expect(isGroupOpen('MQ')).toBe(true);

    toggleGroup('MQ');
    navigate('/layer/kafka/service');
    await nextTick();
    expect(isGroupOpen('MQ')).toBe(true);
  });

  it('preserves manual collapse of the active group when a menu refresh keeps its membership', async () => {
    navigate('/layer/activemq/service');
    const { entries, isGroupOpen, toggleGroup } = setup();
    toggleGroup('MQ');

    entries.value = buildSidebarEntries(menu.map((row) => ({ ...row, serviceCount: 2 })));
    await nextTick();

    expect(isGroupOpen('MQ')).toBe(false);
    expect(isGroupOpen('Databases')).toBe(true);
  });

  it('opens a previously collapsed group when its active singleton gains another member', async () => {
    navigate('/layer/activemq/service');
    const { entries, isGroupOpen, toggleGroup } = setup();
    toggleGroup('MQ');

    entries.value = buildSidebarEntries([mq, ai, mysql, postgres]);
    await nextTick();
    expect(entries.value[0]).toEqual({ kind: 'single', layer: mq });

    entries.value = buildSidebarEntries(menu);
    await nextTick();
    expect(isGroupOpen('MQ')).toBe(true);
  });
});
