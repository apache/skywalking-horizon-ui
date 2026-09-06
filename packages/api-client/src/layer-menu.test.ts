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
 * The default menu order, pinned directly.
 *
 * The bundled-template regression suite in the BFF proves no shipped layer
 * moved, but it can only exercise the row combinations those 44 layers
 * happen to have. This pins the ORDER ITSELF against a frozen transcript
 * of the pre-refactor sidebar, so a combination no bundled layer carries
 * is covered too.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LAYER_ROW_ORDER,
  resolveLayerMenuRows,
  firstLayerMenuRow,
  isBuiltInLayerRow,
  menuOrderIssues,
  type LayerCaps,
  type LayerMenuInput,
} from './index.js';

/**
 * The row order transcribed from `SidebarLayerChildren.vue` as it stood
 * before row resolution was centralised — one entry per `RouterLink`, top
 * to bottom. This is a historical record: it is never edited to match a
 * change, only consulted to prove a change did not happen.
 */
const SIDEBAR_ORDER_BEFORE = [
  'service',
  'instance',
  'endpoint',
  'topology',
  'deployment',
  'dependency',
  'trace',
  'zipkin-trace',
  'logs',
  'browser-errors',
  'pod-logs',
  'trace-profiling',
  'ebpf-profiling',
  'network-profiling',
  'continuous-profiling',
  'pprof',
  'async-profiling',
];

/** Every cap on, so each row's predicate passes and the resolver has to
 *  emit the complete list. `traces.source: 'both'` is what surfaces the
 *  second (Zipkin) trace row. */
const EVERY_ROW: LayerMenuInput = {
  caps: {
    dashboards: true,
    instances: true,
    endpoints: true,
    serviceMap: true,
    deployment: true,
    endpointDependency: true,
    traces: true,
    logs: true,
    browserErrors: true,
    podLogs: true,
    aiConversations: true,
    traceProfiling: true,
    ebpfProfiling: true,
    networkProfiling: true,
    continuousProfiling: true,
    pprofProfiling: true,
    asyncProfiling: true,
  } satisfies LayerCaps,
  slots: {},
  traces: { source: 'both' },
};

describe('DEFAULT_LAYER_ROW_ORDER', () => {
  it('is exactly the order the sidebar rendered before centralisation', () => {
    // Rows added since the transcript (`conversations`) are allowed; what must
    // not move is the relative order of every row the transcript knew.
    expect(DEFAULT_LAYER_ROW_ORDER.filter((p) => SIDEBAR_ORDER_BEFORE.includes(p))).toEqual(
      SIDEBAR_ORDER_BEFORE,
    );
  });

  it('lists every row once — no duplicate, no omission', () => {
    expect(new Set(DEFAULT_LAYER_ROW_ORDER).size).toBe(DEFAULT_LAYER_ROW_ORDER.length);
  });

  it('is the full set of built-in rows', () => {
    for (const path of DEFAULT_LAYER_ROW_ORDER) expect(isBuiltInLayerRow(path)).toBe(true);
    expect(isBuiltInLayerRow('resource')).toBe(false);
    expect(isBuiltInLayerRow('service/agents')).toBe(false);
  });

  it('is what a layer exposing every row resolves to', () => {
    expect(resolveLayerMenuRows(EVERY_ROW).map((r) => r.path)).toEqual([...DEFAULT_LAYER_ROW_ORDER]);
  });

  it('resolves any subset in list order, never in cap-declaration order', () => {
    // Caps declared back-to-front; the output must still follow the list.
    const layer: LayerMenuInput = {
      caps: { asyncProfiling: true, logs: true, dashboards: true, endpoints: true },
      slots: {},
    };
    expect(resolveLayerMenuRows(layer).map((r) => r.path)).toEqual([
      'service',
      'endpoint',
      'logs',
      'async-profiling',
    ]);
  });

  it('lands a layer on the first entry of the list that it exposes', () => {
    expect(firstLayerMenuRow(EVERY_ROW)).toBe('service');
    expect(firstLayerMenuRow({ caps: { instances: true, logs: true }, slots: {} })).toBe('instance');
    expect(firstLayerMenuRow({ caps: { logs: true, traces: true }, slots: {} })).toBe('trace');
    expect(firstLayerMenuRow({ caps: {}, slots: {} })).toBe('service');
    expect(firstLayerMenuRow(undefined)).toBe('service');
  });
});

describe('extension pages in the default order', () => {
  const pages = {
    service: [
      { id: 'resource', name: 'Resource usage' },
      { id: 'agents', name: 'Agents', serviceFilter: '/^agent::/' },
    ],
    instance: [{ id: 'runtime', name: 'Runtime' }],
  };

  it('follows its own component, in template order', () => {
    const layer: LayerMenuInput = {
      caps: { dashboards: true, instances: true, logs: true },
      slots: {},
      extPages: pages,
    };
    expect(resolveLayerMenuRows(layer).map((r) => r.path)).toEqual([
      'service',
      'service/resource',
      'service/agents',
      'instance',
      'instance/runtime',
      'logs',
    ]);
  });

  it('carries the page name so the sidebar can label it', () => {
    const layer: LayerMenuInput = { caps: { dashboards: true }, slots: {}, extPages: pages };
    const row = resolveLayerMenuRows(layer).find((r) => r.path === 'service/agents');
    expect(row?.name).toBe('Agents');
    // Built-in rows carry no name — their labels are literal t() calls.
    expect(resolveLayerMenuRows(layer).find((r) => r.path === 'service')?.name).toBeUndefined();
  });

  it('drops pages whose component resolves no row', () => {
    // Publishing rejects this, so it only guards content written straight
    // to OAP — but a page with no entity to render against must not appear.
    const layer: LayerMenuInput = { caps: { dashboards: false, logs: true }, slots: {}, extPages: pages };
    expect(resolveLayerMenuRows(layer).map((r) => r.path)).toEqual(['logs']);
  });

  it('keeps the component itself as the landing row when it has pages', () => {
    // Service off, Instance on: the instance page follows its component,
    // so the landing row is still the component itself.
    const layer: LayerMenuInput = { caps: { instances: true }, slots: {}, extPages: pages };
    expect(firstLayerMenuRow(layer)).toBe('instance');
    expect(resolveLayerMenuRows(layer).map((r) => r.path)).toEqual(['instance', 'instance/runtime']);
  });
});

describe('menuOrder — the operator-defined order', () => {
  const LAYER: LayerMenuInput = {
    caps: { dashboards: true, instances: true, logs: true, traces: true },
    slots: {},
    extPages: { service: [{ id: 'agents', name: 'Agents' }] },
  };
  const paths = (l: LayerMenuInput) => resolveLayerMenuRows(l).map((r) => r.path);

  it('is the default order when absent', () => {
    expect(paths(LAYER)).toEqual(['service', 'service/agents', 'instance', 'trace', 'logs']);
  });

  it('reorders to exactly what was stored', () => {
    const order = ['logs', 'service/agents', 'service', 'trace', 'instance'];
    expect(paths({ ...LAYER, menuOrder: order })).toEqual(order);
  });

  it('lets an extension page become the landing row', () => {
    const l = { ...LAYER, menuOrder: ['service/agents', 'service', 'instance', 'trace', 'logs'] };
    expect(firstLayerMenuRow(l)).toBe('service/agents');
  });

  it('skips a stored row the layer no longer exposes', () => {
    // Instance component switched off after the order was saved: its
    // entry is skipped. The Service page is untouched — its own component
    // is still on — and lands after the named rows because the stale order
    // never mentioned it.
    const l: LayerMenuInput = { ...LAYER, caps: { dashboards: true, logs: true } };
    expect(paths({ ...l, menuOrder: ['logs', 'instance', 'service'] })).toEqual([
      'logs',
      'service',
      'service/agents',
    ]);
  });

  it('keeps a row the order does not mention rather than hiding it', () => {
    // Enabling a component must ADD its row, not leave it invisible
    // because a previously-saved order predates it.
    expect(paths({ ...LAYER, menuOrder: ['logs', 'service'] })).toEqual([
      'logs',
      'service',
      'service/agents',
      'instance',
      'trace',
    ]);
  });

  it('honours a duplicated entry once', () => {
    expect(paths({ ...LAYER, menuOrder: ['logs', 'logs', 'service'] })).toEqual([
      'logs',
      'service',
      'service/agents',
      'instance',
      'trace',
    ]);
  });

  it('ignores an empty order', () => {
    expect(paths({ ...LAYER, menuOrder: [] })).toEqual(paths(LAYER));
  });

  it('reports what publishing must refuse', () => {
    const rows = resolveLayerMenuRows(LAYER);
    expect(menuOrderIssues(['service', 'nope', 'service'], rows)).toEqual([
      { path: 'nope', issue: 'unknown' },
      { path: 'service', issue: 'duplicate' },
    ]);
    expect(menuOrderIssues(['service', 'logs'], rows)).toEqual([]);
    expect(menuOrderIssues(undefined, rows)).toEqual([]);
  });
});

describe('a layer whose only screen gains a page', () => {
  // The plan's case: a service-only layer is a DIRECT link, because its
  // accordion would reveal only the row the layer row already points at.
  // Adding one page gives it a second row, so it must become expandable —
  // otherwise the page it just gained is unreachable from the sidebar.
  const serviceOnly: LayerMenuInput = { caps: { dashboards: true }, slots: {} };

  it('is a single row before the page', () => {
    expect(resolveLayerMenuRows(serviceOnly).map((r) => r.path)).toEqual(['service']);
    expect(resolveLayerMenuRows(serviceOnly).length <= 1).toBe(true);
  });

  it('becomes two rows, and therefore expandable, after it', () => {
    const withPage: LayerMenuInput = {
      ...serviceOnly,
      extPages: { service: [{ id: 'resource', name: 'Resource usage' }] },
    };
    expect(resolveLayerMenuRows(withPage).map((r) => r.path)).toEqual(['service', 'service/resource']);
    expect(resolveLayerMenuRows(withPage).length <= 1).toBe(false);
    // And the layer still lands on its component, not on the page.
    expect(firstLayerMenuRow(withPage)).toBe('service');
  });
});
