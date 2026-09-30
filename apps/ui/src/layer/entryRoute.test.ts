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
import { resolveEntry } from '@/utils/layerRoute';
import { entryRedirect, rosterReadKey, type EntryRouteState } from './entryRoute';

const rows = (...paths: string[]) => paths.map((path) => ({ path, icon: 'svc' as const }));
const entry = (key: string, serviceGroup?: string, menuRows = rows('service', 'topology')) =>
  ({ key, serviceGroup, menuRows }) as unknown as LayerDef;

// GENERAL split: a reader granted the payments and risk groups only.
const GROUPS_ONLY = [entry('general/payments', 'payments'), entry('general/risk', 'risk'), entry('mesh', undefined, rows('topology', 'service'))];
// GENERAL split, with services that have no group.
const WITH_UNGROUPED = [entry('general/', ''), ...GROUPS_ONLY];

function at(menu: LayerDef[], layer: string, group: string | undefined, row: string | undefined, namesService = false): EntryRouteState {
  const e = resolveEntry(menu, layer, group);
  return { menu, entry: e, groupParam: group, row, namesService, layer: e.def };
}

describe('the roster a layer page reads', () => {
  it('waits for the menu to say whether the layer is split', () => {
    expect(rosterReadKey('general', undefined, resolveEntry([], 'general'), true)).toBe('');
    expect(rosterReadKey('general', 'payments', resolveEntry([], 'general', 'payments'), true)).toBe('');
  });

  it('is the entry\'s own once the menu has answered', () => {
    expect(rosterReadKey('general', undefined, resolveEntry(WITH_UNGROUPED, 'general'), false)).toBe('general/');
    expect(rosterReadKey('general', 'payments', resolveEntry(WITH_UNGROUPED, 'general', 'payments'), false)).toBe('general/payments');
    expect(rosterReadKey('mesh', undefined, resolveEntry(WITH_UNGROUPED, 'mesh'), false)).toBe('mesh');
  });

  it('is read for a layer the menu lacks, whose refusal says "no access"', () => {
    expect(rosterReadKey('so11y_oap', undefined, resolveEntry(WITH_UNGROUPED, 'so11y_oap'), false)).toBe('so11y_oap');
  });

  it('is not read for a segment that names no layer, or a group on a layer that is not split', () => {
    expect(rosterReadKey('general~payments', undefined, resolveEntry(WITH_UNGROUPED, 'general~payments'), false)).toBe('');
    expect(rosterReadKey('mesh', 'payments', resolveEntry(WITH_UNGROUPED, 'mesh', 'payments'), false)).toBe('');
  });
});

describe('where a layer URL is sent', () => {
  it('sends a split layer\'s URL without a group to the reader\'s first group entry, on the same row', () => {
    expect(entryRedirect(at(GROUPS_ONLY, 'general', undefined, 'topology'))).toBe('/layer/general/payments/topology');
    expect(entryRedirect(at(GROUPS_ONLY, 'general', undefined, undefined))).toBe('/layer/general/payments/service');
  });

  it('keeps it for a reader who has the entry for services with no group', () => {
    expect(entryRedirect(at(WITH_UNGROUPED, 'general', undefined, 'topology'))).toBeNull();
  });

  it('keeps it when the URL names a service, which the page says it cannot show', () => {
    expect(entryRedirect(at(GROUPS_ONLY, 'general', undefined, 'service', true))).toBeNull();
  });

  it('never sends a group URL elsewhere, even a group the reader has no entry of', () => {
    expect(entryRedirect(at(GROUPS_ONLY, 'general', 'payments', 'topology'))).toBeNull();
    expect(entryRedirect(at(GROUPS_ONLY, 'general', 'audit', 'topology'))).toBeNull();
    expect(entryRedirect(at(GROUPS_ONLY, 'mesh', 'payments', 'topology'))).toBeNull();
  });

  it('opens an entry\'s first tab from its bare URL, keeping its group', () => {
    expect(entryRedirect(at(GROUPS_ONLY, 'general', 'risk', undefined))).toBe('/layer/general/risk/service');
    expect(entryRedirect(at(WITH_UNGROUPED, 'mesh', undefined, undefined))).toBe('/layer/mesh/topology');
  });

  it('opens the first tab in place of a built-in tab the layer does not offer, keeping the group', () => {
    expect(entryRedirect(at(GROUPS_ONLY, 'general', 'risk', 'trace'))).toBe('/layer/general/risk/service');
    expect(entryRedirect(at(WITH_UNGROUPED, 'general', undefined, 'trace'))).toBe('/layer/general/service');
  });

  it('leaves a tab the layer offers, a sub page and a path that is not a tab', () => {
    expect(entryRedirect(at(GROUPS_ONLY, 'general', 'risk', 'topology'))).toBeNull();
    expect(entryRedirect(at(GROUPS_ONLY, 'general', 'risk', 'service/usage'))).toBeNull();
    expect(entryRedirect(at(GROUPS_ONLY, 'general', 'risk', 'not-a-tab'))).toBeNull();
  });

  it('leaves an entry the menu does not know at its address', () => {
    expect(entryRedirect(at(WITH_UNGROUPED, 'nope', undefined, undefined))).toBeNull();
    expect(entryRedirect(at(WITH_UNGROUPED, 'nope', undefined, 'service'))).toBeNull();
  });
});
