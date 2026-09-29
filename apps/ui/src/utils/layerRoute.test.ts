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
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import {
  entryForService,
  entryKey,
  findEntry,
  groupOfSegment,
  layerPath,
  parseEntryKey,
  resolveEntry,
  rowPath,
  widgetEntryKey,
  widgetLayerEntry,
  widgetLayerOf,
} from './layerRoute';

const entry = (key: string, serviceGroup?: string) => ({ key, serviceGroup }) as LayerDef;
// GENERAL split by service group, with services that have no group; MESH not split.
const MENU = [entry('general/', ''), entry('general/payments', 'payments'), entry('general/risk', 'risk'), entry('mesh')];

describe('entry keys', () => {
  it('read back as the layer and the group, whatever the group contains', () => {
    expect(parseEntryKey('general/payments')).toEqual({ layer: 'general', group: 'payments' });
    expect(parseEntryKey('general/')).toEqual({ layer: 'general', group: '' });
    expect(parseEntryKey('general/a%2Fb')).toEqual({ layer: 'general', group: 'a/b' });
    expect(parseEntryKey('MESH')).toEqual({ layer: 'mesh' });
    expect(entryKey({ layer: 'general', group: 'a/b' })).toBe('general/a%2Fb');
    expect(entryKey({ layer: 'general', group: '' })).toBe('general/');
    expect(entryKey({ layer: 'mesh' })).toBe('mesh');
  });
});

describe('layer URLs', () => {
  it('give a group its own segment and the services with no group the layer\'s own URLs', () => {
    expect(layerPath({ layer: 'general', group: 'payments' }, 'topology')).toBe('/layer/general/payments/topology');
    expect(layerPath({ layer: 'general', group: '' }, 'topology')).toBe('/layer/general/topology');
    expect(layerPath({ layer: 'mesh' }, 'service')).toBe('/layer/mesh/service');
    // A group named like a tab still opens its own tab: its address carries one.
    expect(layerPath({ layer: 'general', group: 'topology' }, 'service')).toBe('/layer/general/topology/service');
  });

  it('put a sub page under page/, for every entity component', () => {
    expect(rowPath('service/usage')).toBe('service/page/usage');
    expect(rowPath('instance/jvm')).toBe('instance/page/jvm');
    expect(rowPath('endpoint/slow')).toBe('endpoint/page/slow');
    expect(rowPath('topology')).toBe('topology');
    expect(layerPath({ layer: 'general', group: 'service' }, 'service/topology')).toBe('/layer/general/service/service/page/topology');
  });

  it('encode a group that is not a plain path segment', () => {
    expect(layerPath({ layer: 'general', group: 'a/b c' }, 'service')).toBe('/layer/general/a%2Fb%20c/service');
  });

  // A segment of only dots is a relative step to a browser, even encoded.
  it('write a group of only dots with two more, and read it back', () => {
    expect(layerPath({ layer: 'general', group: '.' }, 'service')).toBe('/layer/general/.../service');
    expect(layerPath({ layer: 'general', group: '..' }, 'service')).toBe('/layer/general/..../service');
    expect(groupOfSegment('...')).toBe('.');
    expect(groupOfSegment('....')).toBe('..');
    expect(groupOfSegment('.....')).toBe('...');
    expect(resolveEntry([entry('general/..', '..')], 'general', '....')).toMatchObject({ ref: { group: '..' } });
  });
});

describe('the entry a URL names', () => {
  it('is a group\'s entry on a split layer, and the ungrouped entry without a group segment', () => {
    expect(resolveEntry(MENU, 'general', 'payments')).toMatchObject({ key: 'general/payments', split: true, def: MENU[1] });
    expect(resolveEntry(MENU, 'GENERAL', undefined)).toMatchObject({ key: 'general/', split: true, def: MENU[0] });
  });

  it('is the layer\'s one entry when it is not split', () => {
    expect(resolveEntry(MENU, 'mesh')).toMatchObject({ key: 'mesh', split: false, def: MENU[3] });
  });

  it('names no entry for a group on a layer that is not split, or a group the reader has none of', () => {
    expect(resolveEntry(MENU, 'mesh', 'payments')).toMatchObject({ key: 'mesh/payments', split: false, def: null });
    expect(resolveEntry(MENU, 'general', 'audit')).toMatchObject({ key: 'general/audit', split: true, def: null });
  });

  it('cannot tell a split layer before the menu has an entry of it', () => {
    expect(resolveEntry([], 'general')).toMatchObject({ key: 'general', split: null, def: null });
    expect(resolveEntry([], 'general', 'payments')).toMatchObject({ key: 'general/payments', split: null, def: null });
  });
});

describe('a view\'s own menu entry', () => {
  const menu = [entry('general/payments', 'payments'), entry('general/Payments', 'Payments'), entry('mesh')];
  it('is the entry of its key, the group\'s case kept', () => {
    expect(findEntry(menu, 'general/Payments')).toBe(menu[1]);
    expect(findEntry(menu, 'GENERAL/payments')).toBe(menu[0]);
    expect(findEntry(menu, 'MESH')).toBe(menu[2]);
  });

  it('is any entry of a split layer for the whole layer, and none for a group it lacks', () => {
    expect(findEntry(menu, 'general')).toBe(menu[0]);
    expect(findEntry(menu, 'general/risk')).toBeNull();
  });
});

describe('the entry a service opens under', () => {
  it('is its group\'s on a split layer, and the layer\'s otherwise', () => {
    expect(entryForService(MENU, 'GENERAL', 'risk')).toEqual({ layer: 'general', group: 'risk' });
    expect(entryForService(MENU, 'GENERAL', null)).toEqual({ layer: 'general', group: '' });
    // A group the reader has no entry of: the page it opens says why.
    expect(entryForService(MENU, 'GENERAL', 'audit')).toEqual({ layer: 'general', group: 'audit' });
    expect(entryForService(MENU, 'MESH', 'mesh-svr')).toEqual({ layer: 'mesh' });
    expect(entryForService(MENU, 'SO11Y_JAVA_AGENT', 'payments')).toEqual({ layer: 'so11y_java_agent' });
  });
});

describe('an overview widget\'s layer', () => {
  it('is stored the way a grant qualifies a layer, the group as written', () => {
    expect(widgetLayerOf({ layer: 'general', group: 'Payments' })).toBe('GENERAL[Payments]');
    expect(widgetLayerOf({ layer: 'general', group: '' })).toBe('GENERAL[-]');
    expect(widgetLayerOf({ layer: 'mesh' })).toBe('MESH');
  });

  it('cannot be stored for a group the notation would read back as another', () => {
    for (const group of ['-', 'a,b', 'a]', 'a[b', ' padded']) {
      expect(widgetLayerOf({ layer: 'general', group }), group).toBeNull();
    }
  });

  it('reads back as the entry it names', () => {
    expect(widgetLayerEntry('GENERAL[payments]')).toEqual({ layer: 'general', group: 'payments' });
    expect(widgetLayerEntry('GENERAL[-]')).toEqual({ layer: 'general', group: '' });
    expect(widgetLayerEntry('MESH')).toEqual({ layer: 'mesh' });
    expect(widgetEntryKey('GENERAL[Payments]')).toBe('general/Payments');
    expect(widgetEntryKey('MESH')).toBe('mesh');
  });

  it('names no entry for more than one group, or anything else', () => {
    for (const bad of ['GENERAL[a, b]', 'GENERAL[]', 'GENERAL~payments']) {
      expect(widgetLayerEntry(bad), bad).toBeNull();
      expect(widgetEntryKey(bad), bad).toBe('');
    }
  });
});
