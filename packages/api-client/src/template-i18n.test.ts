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
import {
  alignOverlayToSource,
  canonicalizeOverlay,
  idAddressableIds,
  mergeLocalizedNode,
  stampOverlayIds,
} from './template-i18n.js';

const widget = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  type: 'line',
  expressions: [`${id}_expr`],
  ...extra,
});

/** Two widgets and a tab container holding two more — the shapes a layer
 *  dashboard actually ships. */
const source = {
  key: 'GENERAL',
  alias: 'General Service',
  dashboards: {
    service: [
      widget('top_apis', 'Top 20 APIs', {
        tip: 'Busiest endpoints.',
        expressionLabels: ['Traffic', 'Slow', 'Success rate'],
      }),
      widget('traffic_line', 'Traffic'),
      {
        id: 'pods',
        title: 'Pods',
        type: 'tab',
        expressions: [],
        tabs: [
          { name: 'Running', widgets: [widget('pods_running', 'Running pods')] },
          { name: 'Pending', widgets: [widget('pods_pending', 'Pending pods')] },
        ],
      },
    ],
  },
};

const overlay = {
  alias: '普通应用',
  dashboards: {
    service: [
      {
        id: 'top_apis',
        title: '前 20 API',
        tip: '最繁忙的端点。',
        expressionLabels: ['流量', '慢请求', '成功率'],
      },
      { id: 'traffic_line', title: '流量' },
      {
        id: 'pods',
        title: 'Pod',
        tabs: [
          { name: '运行中', widgets: [{ id: 'pods_running', title: '运行中的 Pod' }] },
          { name: '等待中', widgets: [{ id: 'pods_pending', title: '等待中的 Pod' }] },
        ],
      },
    ],
  },
};

/** The overlay as it was authored before ids: same order, no ids. */
const legacyOverlay = {
  alias: '普通应用',
  dashboards: {
    service: [
      { title: '前 20 API', tip: '最繁忙的端点。', expressionLabels: ['流量', '慢请求', '成功率'] },
      { title: '流量' },
      {
        title: 'Pod',
        tabs: [
          { name: '运行中', widgets: [{ title: '运行中的 Pod' }] },
          { name: '等待中', widgets: [{ title: '等待中的 Pod' }] },
        ],
      },
    ],
  },
};

function titles(merged: unknown): string[] {
  const service = (merged as typeof source).dashboards.service;
  return service.map((w) => w.title);
}

function reorder<T>(list: readonly T[], order: readonly number[]): T[] {
  return order.map((i) => list[i]);
}

/** `source` with the tab container's panels replaced. */
function withTabs(tabs: unknown[]): typeof source {
  const container = source.dashboards.service[2] as Record<string, unknown>;
  return {
    ...source,
    dashboards: {
      service: [source.dashboards.service[0], source.dashboards.service[1], { ...container, tabs }],
    },
  } as typeof source;
}

function tabWidgetTitles(merged: unknown): string[][] {
  const container = (merged as typeof source).dashboards.service[2] as unknown as {
    tabs: { widgets: { title: string }[] }[];
  };
  return container.tabs.map((t) => t.widgets.map((w) => w.title));
}

describe('idAddressableIds', () => {
  it('returns the ids when every entry carries a unique one', () => {
    expect(idAddressableIds(source.dashboards.service)).toEqual(['top_apis', 'traffic_line', 'pods']);
  });

  it('refuses an array that repeats an id — those entries cannot be addressed', () => {
    // `deployment.roleToRole[].metrics` pairs a lineClient and a lineServer
    // entry under one id on purpose; such arrays stay positional.
    expect(idAddressableIds([{ id: 'write' }, { id: 'write' }])).toBeNull();
  });

  it('refuses arrays of strings and arrays whose entries have no id', () => {
    expect(idAddressableIds(['Traffic', 'Slow'])).toBeNull();
    expect(idAddressableIds([{ label: 'RPM' }, { label: 'Latency' }])).toBeNull();
    expect(idAddressableIds([])).toBeNull();
  });
});

describe('mergeLocalizedNode — id addressing', () => {
  it('translates every widget when source and overlay agree', () => {
    expect(titles(mergeLocalizedNode(source, overlay))).toEqual(['前 20 API', '流量', 'Pod']);
  });

  it('does not move translations when source widgets are reordered', () => {
    const reordered = {
      ...source,
      dashboards: { service: reorder(source.dashboards.service, [2, 0, 1]) },
    };
    expect(titles(mergeLocalizedNode(reordered, overlay))).toEqual(['Pod', '前 20 API', '流量']);
  });

  it('does not shift later translations when a widget is inserted', () => {
    const inserted = {
      ...source,
      dashboards: {
        service: [source.dashboards.service[0], widget('new_widget', 'Brand new'), ...source.dashboards.service.slice(1)],
      },
    };
    // The inserted widget has no overlay entry, so it stays English.
    expect(titles(mergeLocalizedNode(inserted, overlay))).toEqual(['前 20 API', 'Brand new', '流量', 'Pod']);
  });

  it('does not shift later translations when a widget is deleted', () => {
    const deleted = { ...source, dashboards: { service: source.dashboards.service.slice(1) } };
    expect(titles(mergeLocalizedNode(deleted, overlay))).toEqual(['流量', 'Pod']);
  });

  it('keeps a tab panel’s widget translations attached when the widgets inside it are reordered', () => {
    const twoUp = withTabs([
      {
        name: 'Running',
        widgets: [widget('pods_running', 'Running pods'), widget('pods_pending', 'Pending pods')],
      },
    ]);
    const twoUpOverlay = {
      dashboards: {
        service: [
          null,
          null,
          {
            id: 'pods',
            tabs: [
              {
                widgets: [
                  { id: 'pods_pending', title: '等待中的 Pod' },
                  { id: 'pods_running', title: '运行中的 Pod' },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(tabWidgetTitles(mergeLocalizedNode(twoUp, twoUpOverlay))).toEqual([['运行中的 Pod', '等待中的 Pod']]);
  });

  it('falls back to English when tab PANELS are reordered — a panel has no id to address', () => {
    const container = source.dashboards.service[2] as { tabs: { name: string; widgets: unknown[] }[] };
    const swapped = withTabs(reorder(container.tabs, [1, 0]));
    // The merge descends structurally into `tabs[i].widgets`, and `tabs` has
    // no stable id, so panel 0's overlay now faces panel 1's widget list and
    // addresses nothing in it. English is the honest outcome; the positional
    // merger used to put the Running translation on the Pending widget.
    expect(tabWidgetTitles(mergeLocalizedNode(swapped, overlay))).toEqual([
      ['Pending pods'],
      ['Running pods'],
    ]);
  });

  it('ignores an overlay entry whose id no longer exists in the source', () => {
    const stale = {
      dashboards: { service: [{ id: 'deleted_widget', title: '不存在' }, { id: 'traffic_line', title: '流量' }] },
    };
    expect(titles(mergeLocalizedNode(source, stale))).toEqual(['Top 20 APIs', '流量', 'Pods']);
  });

  it('takes the first of two overlay entries claiming the same id', () => {
    const dup = { dashboards: { service: [{ id: 'traffic_line', title: '流量' }, { id: 'traffic_line', title: '第二个' }] } };
    expect(titles(mergeLocalizedNode(source, dup))).toEqual(['Top 20 APIs', '流量', 'Pods']);
  });

  it('drops positional entries once any entry in the array is id-addressed', () => {
    const mixed = { dashboards: { service: [{ title: '按位置' }, { id: 'traffic_line', title: '流量' }] } };
    expect(titles(mergeLocalizedNode(source, mixed))).toEqual(['Top 20 APIs', '流量', 'Pods']);
  });

  it('never lets an overlay id replace the source id', () => {
    const hostile = { dashboards: { service: [{ id: 'traffic_line', title: '流量' }] } };
    const merged = mergeLocalizedNode(source, hostile) as typeof source;
    expect(merged.dashboards.service.map((w) => w.id)).toEqual(['top_apis', 'traffic_line', 'pods']);
  });
});

describe('mergeLocalizedNode — positional fallback', () => {
  it('merges a legacy overlay that carries no ids', () => {
    expect(titles(mergeLocalizedNode(source, legacyOverlay))).toEqual(['前 20 API', '流量', 'Pod']);
  });

  it('keeps merging string arrays by position', () => {
    const merged = mergeLocalizedNode(source, {
      dashboards: { service: [{ id: 'top_apis', expressionLabels: ['流量', null, '成功率'] }] },
    }) as typeof source;
    const labels = (merged.dashboards.service[0] as unknown as { expressionLabels: string[] }).expressionLabels;
    expect(labels).toEqual(['流量', 'Slow', '成功率']);
  });

  it('keeps merging arrays that repeat an id by position', () => {
    const metrics = { metrics: [{ id: 'write', label: 'Write/s' }, { id: 'write', label: 'Write/s' }] };
    const merged = mergeLocalizedNode(metrics, { metrics: [{ label: '写入/秒' }, null] }) as typeof metrics;
    expect(merged.metrics.map((m) => m.label)).toEqual(['写入/秒', 'Write/s']);
  });

  it('leaves the source untouched at leaves the overlay does not fill', () => {
    expect(mergeLocalizedNode(source, { dashboards: { service: [{ id: 'top_apis', title: '' }] } })).toEqual(source);
  });
});

describe('stampOverlayIds', () => {
  it('turns a legacy positional overlay into the id-addressed one', () => {
    expect(stampOverlayIds(source, legacyOverlay)).toEqual(overlay);
  });

  it('is idempotent on an already-stamped overlay', () => {
    expect(stampOverlayIds(source, overlay)).toEqual(overlay);
  });

  it('re-stamps by id, so a stamped overlay survives a source reorder', () => {
    const reordered = { ...source, dashboards: { service: reorder(source.dashboards.service, [2, 0, 1]) } };
    const stamped = stampOverlayIds(reordered, overlay) as typeof overlay;
    expect(stamped.dashboards.service.map((w) => w.id)).toEqual(['top_apis', 'traffic_line', 'pods']);
  });

  it('leaves holes and nulls alone, keeping the overlay positionally dense', () => {
    const sparse: unknown[] = [];
    sparse[1] = { title: '流量' };
    const stamped = stampOverlayIds(source, { dashboards: { service: sparse } }) as {
      dashboards: { service: unknown[] };
    };
    expect(JSON.stringify(stamped.dashboards.service)).toBe('[null,{"id":"traffic_line","title":"流量"}]');
  });

  it('does not stamp arrays that are not id-addressable', () => {
    const metrics = { metrics: [{ id: 'write' }, { id: 'write' }] };
    expect(stampOverlayIds(metrics, { metrics: [{ label: '写入/秒' }] })).toEqual({ metrics: [{ label: '写入/秒' }] });
  });
});

describe('alignOverlayToSource', () => {
  it('reorders an id-addressed overlay into the source order for positional readers', () => {
    const reordered = { ...source, dashboards: { service: reorder(source.dashboards.service, [2, 0, 1]) } };
    const aligned = alignOverlayToSource(reordered, overlay) as { dashboards: { service: { title: string }[] } };
    expect(aligned.dashboards.service.map((w) => w.title)).toEqual(['Pod', '前 20 API', '流量']);
  });

  it('pads with null where the overlay says nothing about a source entry', () => {
    const aligned = alignOverlayToSource(source, {
      dashboards: { service: [{ id: 'pods', title: 'Pod' }] },
    }) as { dashboards: { service: unknown[] } };
    expect(aligned.dashboards.service).toEqual([null, null, { id: 'pods', title: 'Pod' }]);
  });

  it('passes a legacy positional overlay straight through', () => {
    expect(alignOverlayToSource(source, legacyOverlay)).toEqual(legacyOverlay);
  });
});

/** The merger exactly as it behaved before entries carried ids. Pins the
 *  rollout claim: a stamped catalog pushed to an OAP that a previously
 *  released Horizon reads must render what the legacy catalog rendered. */
function positionalMerge(source: unknown, overlay: unknown): unknown {
  if (Array.isArray(source)) {
    if (!Array.isArray(overlay)) return source;
    return source.map((item, i) => positionalMerge(item, overlay[i]));
  }
  if (source !== null && typeof source === 'object') {
    if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return source;
    const ovl = overlay as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) out[k] = positionalMerge(v, ovl[k]);
    return out;
  }
  if (typeof source === 'string') {
    if (typeof overlay === 'string' && overlay.length > 0) return overlay;
    return source;
  }
  return source;
}

describe('stamping is invisible to a previously-released Horizon', () => {
  it('renders identically under the positional-only merger', () => {
    expect(positionalMerge(source, stampOverlayIds(source, legacyOverlay))).toEqual(
      positionalMerge(source, legacyOverlay),
    );
  });

  it('renders identically under the id-aware merger too', () => {
    expect(mergeLocalizedNode(source, stampOverlayIds(source, legacyOverlay))).toEqual(
      positionalMerge(source, legacyOverlay),
    );
  });
});

describe('overlay content is untrusted', () => {
  it('does not let an overlay `__proto__` key become the result prototype', () => {
    const overlays = [
      JSON.parse('{"dashboards":{"service":[{"__proto__":{"title":"HIJACK"}}]}}'),
      JSON.parse('{"__proto__":{"alias":"HIJACK"}}'),
    ];
    for (const hostile of overlays) {
      for (const fn of [mergeLocalizedNode, stampOverlayIds, alignOverlayToSource, canonicalizeOverlay]) {
        const out = fn(source, hostile) as Record<string, unknown>;
        expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
        expect((out as { title?: string }).title).toBeUndefined();
      }
    }
    expect(titles(mergeLocalizedNode(source, overlays[0]))).toEqual(['Top 20 APIs', 'Traffic', 'Pods']);
  });
});

describe('canonicalizeOverlay', () => {
  it('gives a legacy overlay and its migrated form the same bytes', () => {
    expect(JSON.stringify(canonicalizeOverlay(source, legacyOverlay))).toBe(
      JSON.stringify(canonicalizeOverlay(source, overlay)),
    );
  });

  it('gives a sparse editor draft and a dense seeded catalog the same bytes', () => {
    const draft: unknown[] = [];
    draft[1] = { title: '流量' };
    const seeded = [null, { id: 'traffic_line', title: '流量' }, null];
    expect(JSON.stringify(canonicalizeOverlay(source, { dashboards: { service: draft } }))).toBe(
      JSON.stringify(canonicalizeOverlay(source, { dashboards: { service: seeded } })),
    );
  });

  it('renders the same as the overlay it came from', () => {
    expect(mergeLocalizedNode(source, canonicalizeOverlay(source, legacyOverlay))).toEqual(
      mergeLocalizedNode(source, legacyOverlay),
    );
  });
});
