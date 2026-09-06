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
 * A previewed DRAFT resolves the same menu the runtime would.
 *
 * These two builders are the only place a `LayerDef` is assembled in the
 * browser, for template content the BFF has never seen. If they and the
 * BFF disagree, an operator reviewing a draft is shown a menu that is not
 * the one their push will produce — which is the whole reason row
 * resolution is shared code rather than a BFF detail.
 */

import { describe, it, expect } from 'vitest';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { DEFAULT_LAYER_ROW_ORDER } from '@skywalking-horizon-ui/api-client';
import { layerContentToDef, overlayLayerDef, type LayerTemplateContent } from './layerFromTemplate';

const DRAFT: LayerTemplateContent = {
  key: 'CUSTOM_MQ',
  alias: 'Custom MQ',
  components: { service: true, instances: true, logs: true },
  slots: { services: 'Queues' },
  dashboardExtPages: {
    service: [
      { id: 'resource', name: 'Resource usage' },
      { id: 'agents', name: 'Agents', serviceFilter: '/^agent::/' },
    ],
    instance: [{ id: 'runtime', name: 'Runtime' }],
  },
};

const paths = (L: LayerDef): string[] => (L.menuRows ?? []).map((r) => r.path);

describe('layerContentToDef — a draft OAP does not list', () => {
  it('resolves page rows after their component, in draft order', () => {
    expect(paths(layerContentToDef(DRAFT))).toEqual([
      'service',
      'service/resource',
      'service/agents',
      'instance',
      'instance/runtime',
      'logs',
    ]);
  });

  it('carries the page names, so the sidebar can label the rows', () => {
    const rows = layerContentToDef(DRAFT).menuRows ?? [];
    expect(rows.find((r) => r.path === 'service/agents')?.name).toBe('Agents');
  });

  it('carries the service filter a page seeds', () => {
    expect(layerContentToDef(DRAFT).extPages?.service?.[1].serviceFilter).toBe('/^agent::/');
  });

  it('leaves extPages absent for a draft that declares none', () => {
    const def = layerContentToDef({ key: 'X', components: { service: true } });
    expect(def.extPages).toBeUndefined();
    expect(paths(def)).toEqual(['service']);
  });
});

describe('overlayLayerDef — a draft over a live layer', () => {
  /** What the BFF served for the PUBLISHED template: one page, already
   *  resolved into rows. */
  const published = {
    key: 'CUSTOM_MQ',
    name: 'Custom MQ',
    color: '#fff',
    serviceCount: 7,
    active: true,
    level: null,
    slots: { services: 'Queues' },
    caps: { dashboards: true, instances: true, logs: true },
    extPages: { service: [{ id: 'old-page', name: 'Old page' }] },
    menuRows: [
      { path: 'service', icon: 'svc' },
      { path: 'service/old-page', icon: 'svc', name: 'Old page' },
      { path: 'instance', icon: 'prof' },
      { path: 'logs', icon: 'log' },
    ],
  } as unknown as LayerDef;

  it('replaces the published pages rather than merging them', () => {
    // The published `old-page` must not survive: the operator deleted it
    // in the draft, and a preview that still lists it is lying about what
    // the push would do.
    const rows = paths(overlayLayerDef(published, DRAFT));
    expect(rows).not.toContain('service/old-page');
    expect(rows).toEqual([
      'service',
      'service/resource',
      'service/agents',
      'instance',
      'instance/runtime',
      'logs',
    ]);
  });

  it('drops every page row when the draft removes them all', () => {
    const stripped = { ...DRAFT, dashboardExtPages: undefined };
    expect(paths(overlayLayerDef(published, stripped))).toEqual(['service', 'instance', 'logs']);
  });

  it('re-resolves rows from the draft rather than inheriting the served ones', () => {
    // Component turned off in the draft: its row AND its pages go.
    // Explicitly `false` — omitting the flag means ON, matching the menu
    // route, so an omission would leave the Service row in place.
    const noService = { ...DRAFT, components: { service: false, instances: true, logs: true } };
    expect(paths(overlayLayerDef(published, noService))).toEqual(['instance', 'instance/runtime', 'logs']);
  });

  it('keeps the live counts the menu supplied', () => {
    expect(overlayLayerDef(published, DRAFT).serviceCount).toBe(7);
  });
});

/**
 * The preview's caps must agree with the menu route's, flag for flag.
 * They are two copies of one rule, and a preview that disagrees with the
 * runtime is worse than no preview — it tells the operator their push
 * will do something it will not.
 */
describe('componentsToCaps — parity with the menu route', () => {
  it('treats an absent service flag as ON, like the runtime', () => {
    // `components.service !== false` on the BFF. Reading absence as OFF
    // hid the Service row from every preview of a template that never
    // named the flag.
    const def = layerContentToDef({ key: 'X', components: { instances: true } });
    expect(paths(def)).toEqual(['service', 'instance']);
  });

  it('still honours an explicit service: false', () => {
    const def = layerContentToDef({ key: 'X', components: { service: false, instances: true } });
    expect(paths(def)).toEqual(['instance']);
  });

  it('resolves the network-profiling and pprof rows', () => {
    // Both flags were missing from the mapping, so neither row could ever
    // appear in a preview however the draft was configured.
    const def = layerContentToDef({
      key: 'X',
      components: { service: false, networkProfiling: true, pprofProfiling: true },
    });
    expect(paths(def)).toEqual(['network-profiling', 'pprof']);
  });

  it('resolves every row a fully-enabled draft exposes', () => {
    const def = layerContentToDef({
      key: 'X',
      components: {
        service: true, instances: true, endpoints: true, topology: true, deployment: true,
        endpointDependency: true, traces: true, logs: true, browserErrors: true, podLogs: true,
        traceProfiling: true, ebpfProfiling: true, asyncProfiling: true, networkProfiling: true,
        pprofProfiling: true, continuousProfiling: true, aiConversations: true,
      },
      deployment: { roles: [] },
      traces: { source: 'both' },
    });
    expect(paths(def)).toEqual([...DEFAULT_LAYER_ROW_ORDER]);
  });
});
