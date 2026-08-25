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
 * Finding, and removing, translations for things the template no longer
 * has.
 *
 * They render as nothing — the merger ignores them, which is what keeps a
 * catalog working through a template edit. The reason to surface them is
 * that they are otherwise invisible and can come back: reusing a deleted
 * page's id would pick up its old text.
 */

import { describe, it, expect } from 'vitest';
import {
  staleOverlayPaths,
  hasStaleOverlay,
  pruneOverlayToSource,
  mergeLocalizedNode,
} from './index.js';

const w = (id: string, title: string) => ({ id, type: 'line', title, expressions: ['x'] });

const source = () => ({
  key: 'CUSTOM_MQ',
  alias: 'Custom MQ',
  dashboards: { service: [w('svc-a', 'Throughput')] },
  dashboardExtPages: {
    service: [{ id: 'agents', name: 'Agents', widgets: [w('ag-a', 'Agent count')] }],
  },
});

describe('staleOverlayPaths', () => {
  it('finds nothing when the overlay matches the source', () => {
    const overlay = {
      alias: '自定义 MQ',
      dashboards: { service: [{ id: 'svc-a', title: '吞吐量' }] },
      dashboardExtPages: { service: [{ id: 'agents', name: '探针' }] },
    };
    expect(staleOverlayPaths(source(), overlay)).toEqual([]);
    expect(hasStaleOverlay(source(), overlay)).toBe(false);
  });

  it('finds a page the template no longer declares', () => {
    const overlay = {
      dashboardExtPages: {
        service: [
          { id: 'agents', name: '探针' },
          { id: 'deleted', name: '已删除' },
        ],
      },
    };
    expect(staleOverlayPaths(source(), overlay)).toEqual(['dashboardExtPages.service[1]']);
  });

  it('finds a widget removed from a page', () => {
    const overlay = {
      dashboardExtPages: {
        service: [{ id: 'agents', name: '探针', widgets: [{ id: 'gone', title: '旧标题' }] }],
      },
    };
    expect(staleOverlayPaths(source(), overlay)).toEqual(['dashboardExtPages.service[0].widgets[0]']);
  });

  it('finds a whole scope the template dropped', () => {
    const overlay = { dashboards: { instance: [{ id: 'x', title: 'gone' }] } };
    expect(staleOverlayPaths(source(), overlay)).toEqual(['dashboards.instance']);
  });

  it('finds a field the source never had', () => {
    expect(staleOverlayPaths(source(), { madeUp: 'x' })).toEqual(['madeUp']);
  });

  it('never reports the id — it is the matching key, not content', () => {
    const overlay = { dashboardExtPages: { service: [{ id: 'agents', name: '探针' }] } };
    expect(staleOverlayPaths(source(), overlay).some((p) => p.endsWith('.id'))).toBe(false);
  });

  it('reports a positional entry past the end of its source array', () => {
    // `expressionLabels` has no ids, so it matches by position.
    const src = { dashboards: { service: [{ ...w('svc-a', 'T'), expressionLabels: ['one'] }] } };
    const overlay = { dashboards: { service: [{ id: 'svc-a', expressionLabels: ['一', '二'] }] } };
    expect(staleOverlayPaths(src, overlay)).toEqual(['dashboards.service[0].expressionLabels[1]']);
  });
});

describe('pruneOverlayToSource', () => {
  it('drops exactly the stale entries and keeps the rest', () => {
    const overlay = {
      alias: '自定义 MQ',
      dashboardExtPages: {
        service: [
          { id: 'agents', name: '探针' },
          { id: 'deleted', name: '已删除' },
        ],
      },
      madeUp: 'x',
    };
    const pruned = pruneOverlayToSource(source(), overlay);
    expect(staleOverlayPaths(source(), pruned)).toEqual([]);
    expect(pruned).toEqual({
      alias: '自定义 MQ',
      dashboardExtPages: { service: [{ id: 'agents', name: '探针' }] },
    });
  });

  it('changes nothing a reader would see', () => {
    // The property that makes cleanup safe to offer: pruning alters the
    // RECORD, never the rendered result.
    const overlay = {
      alias: '自定义 MQ',
      dashboards: { service: [{ id: 'svc-a', title: '吞吐量' }] },
      dashboardExtPages: {
        service: [
          { id: 'agents', name: '探针' },
          { id: 'deleted', name: '已删除' },
        ],
      },
    };
    const before = mergeLocalizedNode(source(), overlay);
    const after = mergeLocalizedNode(source(), pruneOverlayToSource(source(), overlay));
    expect(after).toEqual(before);
  });

  it('is idempotent', () => {
    const overlay = { dashboardExtPages: { service: [{ id: 'gone', name: 'x' }] } };
    const once = pruneOverlayToSource(source(), overlay);
    expect(pruneOverlayToSource(source(), once)).toEqual(once);
  });

  it('leaves a clean overlay untouched', () => {
    const overlay = { alias: '自定义 MQ', dashboardExtPages: { service: [{ id: 'agents', name: '探针' }] } };
    expect(pruneOverlayToSource(source(), overlay)).toEqual(overlay);
  });

  it('closes the id-reuse hole', () => {
    // Delete `agents`, then create a NEW page that derives the same id.
    // Without a cleanup the old text comes back attached to it.
    const stale = { dashboardExtPages: { service: [{ id: 'agents', name: 'OLD TEXT' }] } };
    const withoutPage = { ...source(), dashboardExtPages: undefined };
    const cleaned = pruneOverlayToSource(withoutPage, stale);
    const reused = mergeLocalizedNode(source(), cleaned) as {
      dashboardExtPages: { service: Array<{ name: string }> };
    };
    expect(reused.dashboardExtPages.service[0].name).toBe('Agents');
    // And the uncleaned overlay is exactly what would have resurrected it.
    const notCleaned = mergeLocalizedNode(source(), stale) as typeof reused;
    expect(notCleaned.dashboardExtPages.service[0].name).toBe('OLD TEXT');
  });
});

/**
 * Legacy overlays that address by POSITION.
 *
 * Rows written before ids were stamped carry none, and the merger keeps
 * applying them positionally — so they render, and they are not
 * leftovers. Both auditors used to branch on the SOURCE alone, taking the
 * id path for such a row and then skipping every entry for having no id.
 * The result was silence: an over-long positional overlay reported no
 * leftovers while its extra entry rendered nothing, and pruning deleted
 * the live ones.
 */
describe('positional (id-less) overlays', () => {
  const twoWidgets = () => ({
    key: 'CUSTOM_MQ',
    dashboards: { service: [w('svc-a', 'Throughput'), w('svc-b', 'Latency')] },
  });

  it('still render, so they are translations and not leftovers', () => {
    const overlay = { dashboards: { service: [{ title: '吞吐量' }, { title: '延迟' }] } };
    const merged = mergeLocalizedNode(twoWidgets(), overlay) as {
      dashboards: { service: Array<{ title: string }> };
    };
    expect(merged.dashboards.service.map((x) => x.title)).toEqual(['吞吐量', '延迟']);
    expect(staleOverlayPaths(twoWidgets(), overlay)).toEqual([]);
  });

  it('report an entry past the end of the source, which renders nothing', () => {
    const overlay = {
      dashboards: { service: [{ title: '吞吐量' }, { title: '延迟' }, { title: '已删除' }] },
    };
    expect(staleOverlayPaths(twoWidgets(), overlay)).toEqual(['dashboards.service[2]']);
  });

  it('report a dead key inside an entry the source still has', () => {
    const overlay = { dashboards: { service: [{ title: '吞吐量', madeUp: 'x' }] } };
    expect(staleOverlayPaths(twoWidgets(), overlay)).toEqual(['dashboards.service[0].madeUp']);
  });

  it('are pruned without changing what a reader sees', () => {
    // The property that makes cleanup safe to offer. Taking the id path
    // here dropped every entry, which broke it.
    const overlay = {
      dashboards: { service: [{ title: '吞吐量' }, { title: '延迟' }, { title: '已删除' }] },
    };
    const pruned = pruneOverlayToSource(twoWidgets(), overlay);
    expect(mergeLocalizedNode(twoWidgets(), pruned)).toEqual(mergeLocalizedNode(twoWidgets(), overlay));
    expect(staleOverlayPaths(twoWidgets(), pruned)).toEqual([]);
  });

  it('keep using ids once the row carries any', () => {
    // A row that HAS ids is addressed by them, unchanged — the fix must
    // not drag id-keyed rows back onto positional matching.
    const overlay = { dashboards: { service: [{ id: 'svc-b', title: '延迟' }, { id: 'gone', title: 'x' }] } };
    expect(staleOverlayPaths(twoWidgets(), overlay)).toEqual(['dashboards.service[1]']);
  });
});
