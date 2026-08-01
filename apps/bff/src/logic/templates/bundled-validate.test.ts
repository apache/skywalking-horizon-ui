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
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBundledTemplates, type TemplateFinding } from './bundled-validate.js';

/** Minimal well-formed layer template — every negative case below is this
 *  with ONE field broken, so a finding can only come from that field. */
function layer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'DEMO',
    alias: 'Demo',
    components: { service: true },
    'layer-header': {
      orderBy: 'cpm',
      columns: [{ metric: 'cpm', label: 'RPM', mqe: 'service_cpm', aggregation: 'sum' }],
    },
    dashboards: {
      service: [
        { id: 'w1', title: 'Traffic', type: 'line', expressions: ['service_cpm'], span: 4, rowSpan: 2 },
      ],
    },
    ...overrides,
  };
}

function overview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo',
    title: 'Demo Dashboard',
    widgets: [
      {
        id: 'tile',
        title: 'Demo',
        type: 'kpi-tile',
        layer: 'DEMO',
        kpis: [{ label: 'RPM', mqe: 'service_cpm' }],
      },
    ],
    ...overrides,
  };
}

/** Write a throw-away bundle (`layers/` + `overviews/`) and validate it. */
function run(files: {
  layers?: Record<string, unknown>;
  overviews?: Record<string, unknown>;
}): TemplateFinding[] {
  const root = mkdtempSync(join(tmpdir(), 'bundled-validate-'));
  for (const dir of ['layers', 'overviews'] as const) {
    mkdirSync(join(root, dir));
    for (const [name, content] of Object.entries(files[dir] ?? {})) {
      writeFileSync(join(root, dir, `${name}.json`), JSON.stringify(content, null, 2));
    }
  }
  return validateBundledTemplates(root);
}

function messages(findings: TemplateFinding[]): string {
  return findings.map((f) => `${f.file}:${f.path} — ${f.message}`).join('\n');
}

describe('validateBundledTemplates — the templates this repo ships', () => {
  it('reports no findings for the shipped bundle', () => {
    const findings = validateBundledTemplates();
    expect(messages(findings)).toBe('');
  });
});

describe('validateBundledTemplates — well-formed fixtures stay clean', () => {
  it('accepts a minimal layer + overview pair', () => {
    expect(run({ layers: { demo: layer() }, overviews: { demo: overview() } })).toEqual([]);
  });
});

describe('validateBundledTemplates — service-list header', () => {
  it('rejects an aggregation the landing route does not accept', () => {
    // The regression that broke KAFKA: the SPA forwards the column verbatim,
    // and `POST /api/layer/:key/landing` 400s the whole body on a bad enum.
    const findings = run({
      layers: {
        demo: layer({
          'layer-header': {
            orderBy: 'cpm',
            columns: [{ metric: 'cpm', label: 'RPM', mqe: 'service_cpm', aggregation: 'max' }],
          },
        }),
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe('layer-header.columns.0.aggregation');
    expect(findings[0].message).toContain("'sum' | 'avg'");
  });

  it('rejects an orderBy that names no column', () => {
    // The regression that broke AWS_DYNAMODB: rows fall back to alphabetical.
    const findings = run({
      layers: {
        demo: layer({
          'layer-header': {
            orderBy: 'throttled',
            columns: [{ metric: 'cpm', label: 'RPM', mqe: 'service_cpm' }],
          },
        }),
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe('layer-header.orderBy');
    expect(findings[0].message).toContain('not one of the header columns');
  });

  it('accepts an absent orderBy (the renderer falls back to the first column)', () => {
    const findings = run({
      layers: {
        demo: layer({
          'layer-header': { columns: [{ metric: 'cpm', label: 'RPM', mqe: 'service_cpm' }] },
        }),
      },
    });
    expect(findings).toEqual([]);
  });

  it('rejects two columns on the same metric', () => {
    const findings = run({
      layers: {
        demo: layer({
          'layer-header': {
            columns: [
              { metric: 'cpm', label: 'RPM', mqe: 'service_cpm' },
              { metric: 'cpm', label: 'RPM (copy)', mqe: 'service_sla' },
            ],
          },
        }),
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe('layer-header.columns.1.metric');
    expect(findings[0].message).toContain('duplicate column metric "cpm"');
  });

  it('rejects a column with neither an mqe nor a metric-catalog mapping', () => {
    const findings = run({
      layers: {
        demo: layer({
          'layer-header': { orderBy: 'lag', columns: [{ metric: 'lag', label: 'Lag' }] },
        }),
      },
    });
    expect(messages(findings)).toContain('no metric-catalog mapping');
  });

  it('rejects more columns than the landing route accepts', () => {
    const columns = Array.from({ length: 11 }, (_, i) => ({
      metric: `m${i}`,
      label: `M${i}`,
      mqe: 'service_cpm',
    }));
    const findings = run({ layers: { demo: layer({ 'layer-header': { columns } }) } });
    expect(messages(findings)).toContain('more columns than the landing request accepts');
  });
});

describe('validateBundledTemplates — dashboard widgets', () => {
  it('rejects an unknown widget type', () => {
    const findings = run({
      layers: {
        demo: layer({
          dashboards: { service: [{ id: 'w1', title: 'X', type: 'gauge', expressions: ['service_cpm'] }] },
        }),
      },
    });
    expect(findings[0].path).toBe('dashboards.service.0.type');
  });

  it('rejects a widget with no expressions', () => {
    const findings = run({
      layers: { demo: layer({ dashboards: { service: [{ id: 'w1', title: 'X', type: 'line', expressions: [] }] } }) },
    });
    expect(messages(findings)).toContain('at least one expression');
  });

  it('rejects an unknown dashboard scope', () => {
    const findings = run({
      layers: {
        demo: layer({
          dashboards: {
            services: [{ id: 'w1', title: 'X', type: 'line', expressions: ['service_cpm'] }],
          },
        }),
      },
    });
    expect(messages(findings)).toContain('dashboards');
  });

  it('flags a widget field the loader silently drops', () => {
    const findings = run({
      layers: {
        demo: layer({
          dashboards: {
            service: [
              { id: 'w1', title: 'X', type: 'line', expressions: ['service_cpm'], colour: 'red' },
            ],
          },
        }),
      },
    });
    expect(messages(findings)).toContain('unknown widget field "colour"');
  });

  it('flags a malformed visibleWhen (tolerated at runtime, so it renders ungated)', () => {
    const findings = run({
      layers: {
        demo: layer({
          dashboards: {
            service: [
              {
                id: 'w1',
                title: 'X',
                type: 'line',
                expressions: ['service_cpm'],
                visibleWhen: 'service_cpm has value',
              },
            ],
          },
        }),
      },
    });
    expect(messages(findings)).toContain('malformed `visibleWhen`');
  });

  it('rejects duplicate widget ids within one scope', () => {
    const w = { title: 'X', type: 'line', expressions: ['service_cpm'] };
    const findings = run({
      layers: { demo: layer({ dashboards: { service: [{ id: 'w1', ...w }, { id: 'w1', ...w }] } }) },
    });
    expect(messages(findings)).toContain('duplicate widget id "w1"');
  });
});

describe('validateBundledTemplates — layer file identity + typos', () => {
  it('rejects a key that does not match the filename', () => {
    const findings = run({ layers: { other: layer() } });
    expect(messages(findings)).toContain('does not match the filename stem');
  });

  it('rejects an unknown top-level key', () => {
    const findings = run({ layers: { demo: layer({ 'layer-headers': {} }) } });
    expect(messages(findings)).toContain('Unrecognized key');
  });

  it('rejects an unknown component flag', () => {
    const findings = run({ layers: { demo: layer({ components: { service: true, tracing: true } }) } });
    expect(messages(findings)).toContain('Unrecognized key');
  });

  it('rejects a config block that ships no metrics', () => {
    // The admin save boundary accepts this (an operator opening the Topology
    // tab seeds exactly it); a shipped FILE that can never draw anything is a
    // defect, so the bundled bar keeps demanding at least one metric.
    const findings = run({ layers: { demo: layer({ topology: { nodeMetrics: [] } }) } });
    expect(messages(findings)).toContain('topology.nodeMetrics');
  });

  it('rejects a metric with an empty MQE', () => {
    const findings = run({
      layers: {
        demo: layer({ topology: { nodeMetrics: [{ id: 'cpm', label: 'RPM', mqe: '' }] } }),
      },
    });
    expect(messages(findings)).toContain('topology.nodeMetrics.0.mqe');
  });

  it('rejects a naming rule whose pattern cannot resolve a display name', () => {
    // No display capture — resolveServiceIdentity finds nothing to return, so
    // the rule silently does nothing at render time.
    const findings = run({
      layers: {
        demo: layer({ naming: { pattern: '^(.+)$', alias: 'namespace', valueGroup: 'namespace' } }),
      },
    });
    expect(messages(findings)).toContain('(?<service>');
  });

  it('accepts a display-only pattern — the resolver supports the partial match', () => {
    // serviceName.ts handles "capture had display but not cluster" explicitly,
    // so demanding the value capture too would fail CI on a valid template.
    const findings = run({
      layers: {
        demo: layer({ naming: { pattern: '^(?<service>.+)$', alias: 'namespace', valueGroup: 'namespace' } }),
      },
    });
    expect(findings).toEqual([]);
  });

  it('rejects a pattern that does not compile', () => {
    const findings = run({
      layers: { demo: layer({ naming: { pattern: '^(?<service>.+', alias: 'group' } }) },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe('naming.pattern');
    expect(findings[0].message).toContain('invalid regex');
  });
});

describe('validateBundledTemplates — deployment roles', () => {
  const pair = (over: Record<string, unknown>) => ({
    deployment: {
      roles: [{ key: 'liaison' }, { key: 'data' }],
      roleToRole: [
        {
          from: 'liaison',
          to: 'data',
          metrics: [{ id: 'write', label: 'Write', mqe: 'service_instance_relation_client_cpm' }],
          ...over,
        },
      ],
    },
  });

  it('rejects a primary that names none of that pair’s metrics', () => {
    const findings = run({ layers: { demo: layer(pair({ primary: 'writes' })) } });
    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe('deployment.roleToRole.0.primary');
    expect(findings[0].message).toContain("is not one of this pair's metric ids (write)");
  });

  it('rejects a pair side that names no configured role', () => {
    const findings = run({ layers: { demo: layer(pair({ from: 'liason' })) } });
    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe('deployment.roleToRole.0.from');
    expect(findings[0].message).toContain('is not a configured deployment role (liaison, data)');
  });

  it('accepts the `*` wildcard on either side', () => {
    expect(run({ layers: { demo: layer(pair({ from: '*', to: '*' })) } })).toEqual([]);
  });
});

describe('validateBundledTemplates — overview dashboards', () => {
  it('rejects a rankBy.kpi index past the widget’s kpis', () => {
    const findings = run({
      layers: { demo: layer() },
      overviews: {
        demo: overview({
          widgets: [
            {
              id: 'tile',
              title: 'Demo',
              type: 'metric-composite',
              layer: 'DEMO',
              kpis: [{ label: 'RPM', mqe: 'service_cpm' }],
              rankBy: { kpi: 2 },
            },
          ],
        }),
      },
    });
    expect(messages(findings)).toContain('out of range');
  });

  it('rejects a widget bound to a layer with no bundled template', () => {
    const findings = run({
      layers: { demo: layer() },
      overviews: {
        demo: overview({
          widgets: [
            { id: 'tile', title: 'Demo', type: 'kpi-tile', layer: 'NOPE', kpis: [{ label: 'RPM', mqe: 'service_cpm' }] },
          ],
        }),
      },
    });
    expect(messages(findings)).toContain('no bundled layer template for "NOPE"');
  });

  it('rejects an id that does not match the filename (translations would never resolve)', () => {
    const findings = run({ layers: { demo: layer() }, overviews: { other: overview() } });
    expect(messages(findings)).toContain('translation overlays would never resolve');
  });

  it('rejects a metric widget with no mqe', () => {
    const findings = run({
      layers: { demo: layer() },
      overviews: {
        demo: overview({ widgets: [{ id: 'm', title: 'M', type: 'metric', layer: 'DEMO' }] }),
      },
    });
    expect(messages(findings)).toContain('requires an `mqe`');
  });

  it('rejects a data-bound widget with no layer', () => {
    const findings = run({
      layers: { demo: layer() },
      overviews: {
        demo: overview({ widgets: [{ id: 'm', title: 'M', type: 'metric', mqe: 'service_cpm' }] }),
      },
    });
    expect(messages(findings)).toContain('requires a `layer`');
  });
});
