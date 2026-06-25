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

import { describe, it, expect } from 'vitest';
import {
  topologyConfigFor,
  endpointDependencyConfigFor,
  tracesConfigFor,
  widgetsForScope,
  type LayerTemplate,
} from './loader.js';
import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';

function widget(id: string): DashboardWidget {
  return {
    id,
    title: id,
    type: 'line',
    expressions: ['service_cpm'],
  };
}

/** Helper to build a minimal LayerTemplate. We only test the
 *  scope-resolution / fallback behavior, so most fields can be left
 *  empty / placeholder. */
function tpl(overrides: Partial<LayerTemplate> = {}): LayerTemplate {
  return {
    key: 'TEST',
    components: { service: true },
    metrics: {},
    ...overrides,
  } as LayerTemplate;
}

describe('widgetsForScope — scope-resolution + fallback chain', () => {
  it('returns the exact dashboards[scope] when present', () => {
    const instance = [widget('inst-1')];
    const service = [widget('svc-1')];
    const t = tpl({ dashboards: { service, instance } });
    expect(widgetsForScope(t, 'instance')).toBe(instance);
  });

  it('falls back to dashboards.service when the requested scope is missing', () => {
    const service = [widget('svc-1')];
    const t = tpl({ dashboards: { service } });
    expect(widgetsForScope(t, 'instance')).toBe(service);
    expect(widgetsForScope(t, 'endpoint')).toBe(service);
    expect(widgetsForScope(t, 'trace')).toBe(service);
  });

  it('falls back to template.widgets when both scope and service missing', () => {
    const legacy = [widget('legacy-1')];
    const t = tpl({ dashboards: { instance: [widget('only-instance')] }, widgets: legacy });
    expect(widgetsForScope(t, 'endpoint')).toBe(legacy);
  });

  it('returns template.widgets when dashboards block is entirely absent', () => {
    const legacy = [widget('legacy-only')];
    const t = tpl({ widgets: legacy });
    expect(widgetsForScope(t, 'service')).toBe(legacy);
    expect(widgetsForScope(t, 'instance')).toBe(legacy);
  });

  it('returns [] when nothing is defined (no dashboards, no legacy widgets)', () => {
    const t = tpl({});
    expect(widgetsForScope(t, 'service')).toEqual([]);
    expect(widgetsForScope(t, 'instance')).toEqual([]);
  });

  it('mesh_dp shape: instance-only template, service request → empty (no leakage)', () => {
    // mesh_dp has components.service:false and dashboards.instance only.
    // A stray request with scope='service' must NOT return the instance
    // widgets — those run envoy_cluster_* metrics that are instance-
    // scope and would render empty / errored at service scope.
    const instance = [widget('envoy-cluster-up-rq-active')];
    const t = tpl({
      dashboards: { instance },
      components: { service: false, instances: true },
    });
    expect(widgetsForScope(t, 'service')).toEqual([]);
    expect(widgetsForScope(t, 'instance')).toBe(instance);
  });

  it('resolves topNOrder on top / record widgets from their top_n() expression', () => {
    const top: DashboardWidget = {
      id: 'sla',
      title: 'Top instances by success rate',
      type: 'top',
      expressions: ['top_n(service_instance_sla,10,asc)/100'],
    };
    const line = widget('cpm-line'); // non-top widget rides through untouched
    const out = widgetsForScope(tpl({ dashboards: { service: [top, line] } }), 'service');
    expect(out.find((w) => w.id === 'sla')?.topNOrder).toBe('asc');
    expect(out.find((w) => w.id === 'cpm-line')).toBe(line); // unchanged reference
  });

  it('resolves topNOrder on a top / record widget INSIDE a tab panel', () => {
    const tabbed: DashboardWidget = {
      id: 'grp',
      title: '',
      type: 'tab',
      expressions: [],
      tabs: [
        {
          name: 'Lists',
          widgets: [
            { id: 'asc-top', title: 'asc', type: 'top', expressions: ['top_n(service_instance_sla,10,asc)/100'] },
            { id: 'plain-card', title: 'c', type: 'card', expressions: ['latest(service_cpm)'] },
          ],
        },
      ],
    };
    const out = widgetsForScope(tpl({ dashboards: { service: [tabbed] } }), 'service');
    const child = out[0].tabs?.[0].widgets.find((w) => w.id === 'asc-top');
    expect(child?.topNOrder).toBe('asc'); // a tab child keeps its declared direction
  });

  it('leaves a tab with no top / record children reference-unchanged', () => {
    const tabbed: DashboardWidget = {
      id: 'grp',
      title: '',
      type: 'tab',
      expressions: [],
      tabs: [{ name: 'Cards', widgets: [{ id: 'c', title: 'c', type: 'card', expressions: ['latest(service_cpm)'] }] }],
    };
    const out = widgetsForScope(tpl({ dashboards: { service: [tabbed] } }), 'service');
    expect(out[0]).toBe(tabbed); // no top/record anywhere → allocation-free pass-through
  });
});

describe('topologyConfigFor / endpointDependencyConfigFor / tracesConfigFor — defaults', () => {
  it('topologyConfigFor returns operator override when set', () => {
    const override = {
      nodeMetrics: [],
      serverMetrics: [],
      clientMetrics: [],
    } as unknown as LayerTemplate['topology'];
    const t = tpl({ topology: override });
    expect(topologyConfigFor(t)).toBe(override);
  });
  it('topologyConfigFor falls back to booster defaults when null template', () => {
    const def = topologyConfigFor(null);
    expect(def).toBeDefined();
    expect(def.nodeMetrics).toBeDefined();
  });

  it('endpointDependencyConfigFor returns the configured block', () => {
    const cfg = { nodeMetrics: [], serverMetrics: [] } as unknown as LayerTemplate['endpointDependency'];
    expect(endpointDependencyConfigFor(tpl({ endpointDependency: cfg }))).toBe(cfg);
  });
  it('endpointDependencyConfigFor falls back to booster defaults when null', () => {
    expect(endpointDependencyConfigFor(null)).toBeDefined();
  });

  it('tracesConfigFor defaults source to "both" when unspecified', () => {
    expect(tracesConfigFor(null)).toEqual({ source: 'both' });
    expect(tracesConfigFor(tpl({}))).toEqual({ source: 'both' });
  });
  it('tracesConfigFor honors the template override (e.g. zipkin for mesh)', () => {
    const t = tpl({ traces: { source: 'zipkin' } });
    expect(tracesConfigFor(t)).toEqual({ source: 'zipkin' });
  });
});
