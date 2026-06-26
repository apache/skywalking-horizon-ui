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
import { buildFragment, type MqeResultShape } from '../../logic/dashboard/mqe.js';
import { parseSeries, avgOf, parseLabeledSeries, parseTopList } from '../../logic/dashboard/parsers.js';
import { flattenTabWidgets } from '../../logic/dashboard/gates.js';
import { widgetSchema } from '../../logic/dashboard/schema.js';
import type { Window } from '../../util/window.js';
import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';

const W: Window = { start: '2026-05-17 1000', end: '2026-05-17 1100', step: 'MINUTE' };

/** Extract just the `entity: { ... }` literal from a built fragment.
 *  Lets assertions target the actual entity-construction logic without
 *  matching against the trailing GraphQL result-shape block (which
 *  always names `serviceName / serviceInstanceName / endpointName` as
 *  field selectors regardless of the entity scope). */
function entityOf(fragment: string): string {
  const m = fragment.match(/entity:\s*(\{[^}]*\})/);
  if (!m) throw new Error(`no entity literal in fragment:\n${fragment}`);
  return m[1];
}

describe('buildFragment — entity scope construction', () => {
  it('default → Service scope with serviceName + normal flag', () => {
    const entity = entityOf(buildFragment('w0', 'service_cpm', 'frontend', true, W));
    expect(entity).toContain('scope: Service');
    expect(entity).toContain('serviceName: "frontend"');
    expect(entity).toContain('normal: true');
    expect(entity).not.toContain('serviceInstanceName');
    expect(entity).not.toContain('endpointName');
  });

  it('default → serializes normal: false when normal flag is false (VIRTUAL_*, AWS_*)', () => {
    const entity = entityOf(buildFragment('w0', 'service_cpm', 'mq-broker', false, W));
    expect(entity).toContain('normal: false');
  });

  it('serviceInstanceName set → ServiceInstance scope, carries instance name', () => {
    const entity = entityOf(
      buildFragment('w0', 'jvm_cpu', 'frontend', true, W, {
        serviceInstanceName: 'frontend-pod-1',
      }),
    );
    expect(entity).toContain('scope: ServiceInstance');
    expect(entity).toContain('serviceName: "frontend"');
    expect(entity).toContain('serviceInstanceName: "frontend-pod-1"');
    expect(entity).not.toContain('endpointName');
  });

  it('endpointName set → Endpoint scope', () => {
    const entity = entityOf(
      buildFragment('w0', 'endpoint_cpm', 'frontend', true, W, {
        endpointName: '/api/order',
      }),
    );
    expect(entity).toContain('scope: Endpoint');
    expect(entity).toContain('endpointName: "/api/order"');
    expect(entity).not.toContain('serviceInstanceName');
  });

  it('layerScope:true → {scope: All}, no serviceName / normal / instance / endpoint in entity', () => {
    const entity = entityOf(
      buildFragment('w0', 'top_n(endpoint_cpm,20,des)', 'frontend', true, W, {
        layerScope: true,
      }),
    );
    expect(entity).toContain('scope: All');
    expect(entity).not.toContain('serviceName');
    expect(entity).not.toContain('serviceInstanceName');
    expect(entity).not.toContain('endpointName');
    expect(entity).not.toContain('normal:');
  });

  it('layerScope:true wins over both serviceInstanceName AND endpointName', () => {
    // Defensive: if a caller sets layerScope:true AND instance/endpoint,
    // we should still produce All scope (layerScope is the explicit
    // opt-out from per-entity filtering).
    const entity = entityOf(
      buildFragment('w0', 'endpoint_cpm', 'frontend', true, W, {
        layerScope: true,
        serviceInstanceName: 'should-be-ignored',
        endpointName: '/should/be/ignored',
      }),
    );
    expect(entity).toContain('scope: All');
    expect(entity).not.toContain('should-be-ignored');
    expect(entity).not.toContain('/should/be/ignored');
  });

  it('serviceInstanceName takes precedence over endpointName when both set', () => {
    const entity = entityOf(
      buildFragment('w0', 'm', 'svc', true, W, {
        serviceInstanceName: 'inst',
        endpointName: '/ep',
      }),
    );
    expect(entity).toContain('scope: ServiceInstance');
    expect(entity).not.toContain('scope: Endpoint');
    expect(entity).not.toContain('/ep');
  });

  it('JSON-stringifies values containing OAP special characters (::, /, quotes)', () => {
    const entity = entityOf(
      buildFragment('w0', 'm', 'mesh-svr::reviews', true, W, {
        endpointName: '/api/"order"',
      }),
    );
    expect(entity).toContain('serviceName: "mesh-svr::reviews"');
    expect(entity).toContain('endpointName: "/api/\\"order\\""');
  });

  it('alias + expression + duration window land in the output', () => {
    const frag = buildFragment('w7', 'service_cpm', 'frontend', true, {
      start: '2026-05-17 1000',
      end: '2026-05-17 1100',
      step: 'MINUTE',
    });
    expect(frag.trimStart().startsWith('w7: execExpression(')).toBe(true);
    expect(frag).toContain('expression: "service_cpm"');
    expect(frag).toContain('start: "2026-05-17 1000"');
    expect(frag).toContain('end: "2026-05-17 1100"');
    expect(frag).toContain('step: MINUTE');
  });

  it('duration step follows the window step (HOUR / DAY)', () => {
    const hour = buildFragment('w8', 'service_cpm', 'frontend', true, {
      start: '2026-05-17 10',
      end: '2026-05-18 10',
      step: 'HOUR',
    });
    expect(hour).toContain('step: HOUR');
    const day = buildFragment('w9', 'service_cpm', 'frontend', true, {
      start: '2026-04-17',
      end: '2026-05-17',
      step: 'DAY',
    });
    expect(day).toContain('step: DAY');
  });

  it('result block requests metric.labels + owner fields (TopList / relabels support)', () => {
    const frag = buildFragment('w0', 'm', 'svc', true, W);
    expect(frag).toContain('metric { labels { key value } }');
    expect(frag).toContain('owner { scope serviceName serviceInstanceName endpointName }');
  });
});

describe('parseSeries — single-series numeric extraction', () => {
  it('returns null for an undefined / errored result', () => {
    expect(parseSeries(undefined)).toBeNull();
    expect(parseSeries({ type: 'TIME_SERIES_VALUES', error: 'boom' })).toBeNull();
  });

  it('returns null when results / values are missing or empty', () => {
    expect(parseSeries({ type: 'TIME_SERIES_VALUES' })).toBeNull();
    expect(parseSeries({ type: 'TIME_SERIES_VALUES', results: [] })).toBeNull();
    expect(
      parseSeries({ type: 'TIME_SERIES_VALUES', results: [{ values: [] }] }),
    ).toBeNull();
  });

  it('maps string values to numbers, preserves null gaps', () => {
    const r: MqeResultShape = {
      type: 'TIME_SERIES_VALUES',
      results: [
        {
          values: [
            { value: '10' },
            { value: null },
            { value: '3.14' },
            { value: undefined },
            { value: 'not-a-number' },
          ],
        },
      ],
    };
    expect(parseSeries(r)).toEqual([10, null, 3.14, null, null]);
  });
});

describe('avgOf — mean over a possibly-sparse series', () => {
  it('returns null on null input', () => {
    expect(avgOf(null)).toBeNull();
  });
  it('returns null on a fully-null series', () => {
    expect(avgOf([null, null, null])).toBeNull();
  });
  it('averages only the non-null values', () => {
    expect(avgOf([10, null, 20, null, 30])).toBe(20);
  });
  it('handles a single value', () => {
    expect(avgOf([42])).toBe(42);
  });
});

describe('parseLabeledSeries — relabels() multi-result extraction', () => {
  it('falls back to the supplied label when metric.labels is empty', () => {
    const r: MqeResultShape = {
      type: 'TIME_SERIES_VALUES',
      results: [{ values: [{ value: '1' }, { value: '2' }] }],
    };
    expect(parseLabeledSeries(r, 'service_cpm')).toEqual([
      { label: 'service_cpm', data: [1, 2] },
    ]);
  });

  it('reads the LAST label.value when metric.labels is set (most-derived label, e.g. percentile=99)', () => {
    const r: MqeResultShape = {
      type: 'TIME_SERIES_VALUES',
      results: [
        {
          metric: {
            labels: [
              { key: 'p', value: '99' },
              { key: 'percentile', value: '99' },
            ],
          },
          values: [{ value: '12' }],
        },
      ],
    };
    expect(parseLabeledSeries(r, 'fallback')).toEqual([{ label: '99', data: [12] }]);
  });

  it('returns null on error / empty / no values', () => {
    expect(parseLabeledSeries(undefined, 'x')).toBeNull();
    expect(parseLabeledSeries({ type: 'X', error: 'boom' }, 'x')).toBeNull();
    expect(parseLabeledSeries({ type: 'X', results: [{ values: [] }] }, 'x')).toBeNull();
  });
});

describe('parseTopList — owner-scope priority for display names', () => {
  it('multi-service endpoint owners → "service · endpoint" (prefix disambiguates)', () => {
    const r: MqeResultShape = {
      type: 'SORTED_LIST',
      results: [
        {
          values: [
            {
              value: '100',
              owner: { scope: 'Endpoint', serviceName: 'frontend', endpointName: '/api/order' },
            },
            {
              value: '80',
              owner: { scope: 'Endpoint', serviceName: 'backend', endpointName: '/api/pay' },
            },
          ],
        },
      ],
    };
    expect(parseTopList(r)).toEqual([
      { name: 'frontend · /api/order', value: 100 },
      { name: 'backend · /api/pay', value: 80 },
    ]);
  });

  it('single-service endpoint owners → endpoint alone (redundant prefix dropped)', () => {
    const r: MqeResultShape = {
      type: 'SORTED_LIST',
      results: [
        {
          values: [
            {
              value: '100',
              owner: { scope: 'Endpoint', serviceName: 'frontend', endpointName: '/api/order' },
            },
            {
              value: '60',
              owner: { scope: 'Endpoint', serviceName: 'frontend', endpointName: '/api/pay' },
            },
          ],
        },
      ],
    };
    expect(parseTopList(r)).toEqual([
      { name: '/api/order', value: 100 },
      { name: '/api/pay', value: 60 },
    ]);
  });

  it('endpoint owner without serviceName → endpoint alone', () => {
    const r: MqeResultShape = {
      type: 'SORTED_LIST',
      results: [
        {
          values: [{ value: '5', owner: { scope: 'Endpoint', endpointName: '/loose' } }],
        },
      ],
    };
    expect(parseTopList(r)).toEqual([{ name: '/loose', value: 5 }]);
  });

  it('multi-service instance owners → "service · instance" (prefix disambiguates)', () => {
    const r: MqeResultShape = {
      type: 'SORTED_LIST',
      results: [
        {
          values: [
            {
              value: '7',
              owner: { scope: 'ServiceInstance', serviceName: 'svc-a', serviceInstanceName: 'pod-1' },
            },
            {
              value: '3',
              owner: { scope: 'ServiceInstance', serviceName: 'svc-b', serviceInstanceName: 'pod-2' },
            },
          ],
        },
      ],
    };
    expect(parseTopList(r)).toEqual([
      { name: 'svc-a · pod-1', value: 7 },
      { name: 'svc-b · pod-2', value: 3 },
    ]);
  });

  it('single-service instance owners → instance alone (redundant prefix dropped)', () => {
    const r: MqeResultShape = {
      type: 'SORTED_LIST',
      results: [
        {
          values: [
            {
              value: '7',
              owner: { scope: 'ServiceInstance', serviceName: 'svc-a', serviceInstanceName: 'pod-1' },
            },
            {
              value: '4',
              owner: { scope: 'ServiceInstance', serviceName: 'svc-a', serviceInstanceName: 'pod-2' },
            },
          ],
        },
      ],
    };
    expect(parseTopList(r)).toEqual([
      { name: 'pod-1', value: 7 },
      { name: 'pod-2', value: 4 },
    ]);
  });

  it('service-only owner → service name', () => {
    const r: MqeResultShape = {
      type: 'SORTED_LIST',
      results: [{ values: [{ value: '3', owner: { scope: 'Service', serviceName: 'frontend' } }] }],
    };
    expect(parseTopList(r)).toEqual([{ name: 'frontend', value: 3 }]);
  });

  it('no owner but value.id present → falls back to id', () => {
    const r: MqeResultShape = {
      type: 'SORTED_LIST',
      results: [{ values: [{ id: 'fallback-id', value: '9' }] }],
    };
    expect(parseTopList(r)).toEqual([{ name: 'fallback-id', value: 9 }]);
  });

  it('no owner, no id → em-dash placeholder', () => {
    const r: MqeResultShape = {
      type: 'SORTED_LIST',
      results: [{ values: [{ value: '1' }] }],
    };
    expect(parseTopList(r)).toEqual([{ name: '—', value: 1 }]);
  });

  it('non-numeric value collapses to null in the rendered list', () => {
    const r: MqeResultShape = {
      type: 'SORTED_LIST',
      results: [{ values: [{ value: 'NaN', owner: { serviceName: 'svc' } }] }],
    };
    expect(parseTopList(r)).toEqual([{ name: 'svc', value: null }]);
  });

  it('null / errored / empty result → null', () => {
    expect(parseTopList(undefined)).toBeNull();
    expect(parseTopList({ type: 'X', error: 'boom' })).toBeNull();
    expect(parseTopList({ type: 'X', results: [{ values: [] }] })).toBeNull();
  });
});

const leaf = (id: string, type: DashboardWidget['type'] = 'card'): DashboardWidget => ({
  id,
  title: id,
  type,
  expressions: [`${id}_mqe`],
});

describe('flattenTabWidgets — tab containers expand to their leaf children', () => {
  it('leaves a tab-free list untouched', () => {
    const ws = [leaf('a'), leaf('b', 'line')];
    expect(flattenTabWidgets(ws)).toEqual(ws);
  });

  it('expands a tab to ONLY the first (default-active) panel’s widgets — lazy, not every panel', () => {
    const ws: DashboardWidget[] = [
      leaf('top1'),
      { id: 'grp', title: '', type: 'tab', expressions: [], tabs: [
        { name: 'T1', widgets: [leaf('a'), leaf('b')] },
        { name: 'T2', widgets: [leaf('c')] },
      ] },
      leaf('top2'),
    ];
    // 'c' (in the non-active second panel) is NOT queried — bounds the OAP request.
    expect(flattenTabWidgets(ws).map((w) => w.id)).toEqual(['top1', 'a', 'b', 'top2']);
    expect(flattenTabWidgets(ws).some((w) => w.type === 'tab')).toBe(false);
  });

  it('tolerates empty / missing tabs (no children → nothing emitted for the container)', () => {
    const ws: DashboardWidget[] = [
      { id: 'g1', title: '', type: 'tab', expressions: [], tabs: [{ name: 'T', widgets: [] }] },
      { id: 'g2', title: '', type: 'tab', expressions: [] },
    ];
    expect(flattenTabWidgets(ws)).toEqual([]);
  });

  it('never recurses a nested tab into the leaf stream (one level deep)', () => {
    const nested: DashboardWidget = { id: 'inner', title: '', type: 'tab', expressions: [], tabs: [] };
    const ws: DashboardWidget[] = [
      { id: 'outer', title: '', type: 'tab', expressions: [], tabs: [{ name: 'T', widgets: [leaf('a'), nested] }] },
    ];
    expect(flattenTabWidgets(ws).map((w) => w.id)).toEqual(['a']);
  });
});

describe('widgetSchema — accepts the tab container', () => {
  it('parses a tab widget with empty expressions + a tabs array', () => {
    const r = widgetSchema.safeParse({
      id: 'grp', title: 'Group', type: 'tab', expressions: [],
      tabs: [{ name: 'Traffic', widgets: [{ id: 'c', title: 'C', type: 'card', expressions: ['m'] }] }],
    });
    expect(r.success).toBe(true);
  });

  it('still rejects a non-tab widget that is malformed (no expressions on a leaf inside a tab)', () => {
    const r = widgetSchema.safeParse({
      id: 'grp', title: 'Group', type: 'tab', expressions: [],
      tabs: [{ name: 'T', widgets: [{ id: 'c', title: 'C', type: 'card', expressions: [] }] }],
    });
    expect(r.success).toBe(false);
  });
});
