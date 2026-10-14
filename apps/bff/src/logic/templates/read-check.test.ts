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
 * The read check refuses what would break rendering and nothing else. Two
 * directions matter equally: every shape that took a page down must be
 * refused, and nothing Horizon itself ships or lets an editor publish may be.
 */

import { describe, expect, it } from 'vitest';
import { iterateBundledOverlays, iterateBundledTemplates } from './aggregator.js';
import { layerTemplatePushSchema, overviewTemplatePushSchema } from './bundled-schema.js';
import { envelopeProblem, overlayReadProblems, templateReadProblems } from './read-check.js';

const LAYER = { key: 'GENERAL', alias: 'General', components: { service: true } };
const layer = (extra: Record<string, unknown>): Record<string, unknown> => ({ ...LAYER, ...extra });
const paths = (problems: Array<{ path: Array<string | number> }>): string[] => problems.map((p) => p.path.join('.'));

describe('read check — what Horizon ships is servable', () => {
  it('passes every bundled template', () => {
    const refused = [...iterateBundledTemplates()]
      .map((t) => ({ name: `${t.kind}.${t.key}`, problems: templateReadProblems(t.kind, t.key, t.content) }))
      .filter((r) => r.problems.length > 0);
    expect(refused).toEqual([]);
  });

  it('passes every bundled translation overlay against its source', () => {
    const sources = new Map([...iterateBundledTemplates()].map((t) => [`${t.kind}.${t.key}`, t.content]));
    const refused = [...iterateBundledOverlays()]
      .map((o) => ({
        name: `${o.kind}.${o.key}.${o.locale}`,
        problems: overlayReadProblems(sources.get(`${o.kind}.${o.key}`), o.content),
      }))
      .filter((r) => r.problems.length > 0);
    expect(refused).toEqual([]);
  });

  it('passes the work in progress the editor publishes', () => {
    // Blank MQE, empty lists, a half-made grouping rule: push-valid, so
    // read-valid — a reader must never refuse what the editor may save.
    const draft = layer({
      dashboards: { service: [{ id: 'w1', title: 'New', type: 'line', expressions: [''], span: 4, rowSpan: 2 }] },
      topology: { nodeMetrics: [], linkServerMetrics: [] },
      deployment: { clusterBy: { kind: 'nameRegex', alias: '' }, roleToRole: [{ from: '', to: '', primary: '', metrics: [] }] },
      menuOrder: ['service', 'no-such-row'],
    });
    expect(layerTemplatePushSchema.safeParse(draft).success).toBe(true);
    expect(templateReadProblems('layer', 'GENERAL', draft)).toEqual([]);

    const overview = { id: 'ops', title: '', widgets: [{ id: 'k', title: '', type: 'kpi-tile', kpis: [] }] };
    expect(overviewTemplatePushSchema.safeParse(overview).success).toBe(true);
    expect(templateReadProblems('overview', 'ops', overview)).toEqual([]);
  });
});

describe('read check — what a newer Horizon writes is not refused', () => {
  it('ignores keys it does not know, top level and nested', () => {
    const newer = layer({
      someFutureBlock: { a: 1 },
      components: { service: true, someFutureTab: true },
      topology: { nodeMetrics: [{ id: 'cpm', label: 'RPM', mqe: 'service_cpm', futureField: 'x' }] },
    });
    expect(templateReadProblems('layer', 'GENERAL', newer)).toEqual([]);
  });

  it('ignores values the renderer copes with outside widgets and header columns', () => {
    expect(templateReadProblems('layer', 'GENERAL', layer({ visibility: 'somewhere-new', menuOrder: ['gone'] }))).toEqual(
      [],
    );
    const overview = {
      id: 'ops',
      title: 'Ops',
      widgets: [{ id: 'w', title: 'W', type: 'a-future-widget', span: 40, layer: 'GENERAL' }],
    };
    expect(templateReadProblems('overview', 'ops', overview)).toEqual([]);
  });
});

describe('read check — what took a page down is refused', () => {
  it.each([
    ['no components (the menu build)', { key: 'GENERAL' }, 'components'],
    ['a dashboard scope that is not a list (the bundle)', layer({ dashboards: { service: {} } }), 'dashboards.service'],
    ['extension pages that are not a list', layer({ dashboardExtPages: { service: {} } }), 'dashboardExtPages.service'],
    ['a key that is not a string', layer({ key: 1 }), 'key'],
    ['a documentLink that is not a string', layer({ documentLink: 42 }), 'documentLink'],
    ['a menuOrder that is not a list', layer({ menuOrder: 5 }), 'menuOrder'],
    ['trace sources that are not a list', layer({ traces: { sources: 5 } }), 'traces.sources'],
    ['a topology block with no node metrics', layer({ topology: {} }), 'topology.nodeMetrics'],
  ])('%s', (_label, content, path) => {
    expect(paths(templateReadProblems('layer', 'GENERAL', content))).toContain(path);
  });

  it('refuses any defect in a widget, which fails the whole dashboard batch', () => {
    const content = layer({
      dashboards: { service: [{ id: 'w1', title: 'Load', type: 'line', expressions: ['service_cpm'], span: 99 }] },
    });
    expect(paths(templateReadProblems('layer', 'GENERAL', content))).toEqual(['dashboards.service.0.span']);
  });

  it('refuses more header columns than the service list request accepts', () => {
    const columns = Array.from({ length: 11 }, (_, i) => ({ metric: `m${i}`, label: `M${i}` }));
    expect(paths(templateReadProblems('layer', 'GENERAL', layer({ 'layer-header': { columns } })))).toEqual([
      'layer-header.columns',
    ]);
  });

  it('refuses an overview with no widget list', () => {
    expect(paths(templateReadProblems('overview', 'ops', { id: 'ops', title: 'Ops' }))).toEqual(['widgets']);
  });

  it('holds an alarm page to the schema its reader already applied', () => {
    expect(paths(templateReadProblems('alert', 'payments', { id: 'payments', title: 'Payments' }))).toEqual([
      'pinnedLayers',
    ]);
  });
});

describe('read check — translation overlays', () => {
  const source = { key: 'GENERAL', alias: 'General', dashboards: { service: [{ id: 'w1', title: 'Load', type: 'line' }] } };

  it('refuses one that would rewrite a value outside the translatable allowlist', () => {
    expect(paths(overlayReadProblems(source, { key: 'MESH' }))).toEqual(['key']);
    expect(paths(overlayReadProblems(source, { dashboards: { service: [{ id: 'w1', type: 'top' }] } }))).toEqual([
      'dashboards.service.0.type',
    ]);
  });

  it('serves wording, and drift the merger skips', () => {
    expect(overlayReadProblems(source, { alias: '通用', dashboards: { service: [{ id: 'w1', title: '负载' }] } })).toEqual(
      [],
    );
    expect(overlayReadProblems(source, { dashboards: { service: [{ id: 'removed-widget', title: 'x' }] } })).toEqual(
      [],
    );
  });

  it('refuses one that is not an object', () => {
    expect(overlayReadProblems(source, ['x'])).toEqual([{ path: [], message: 'a translation overlay must be a JSON object' }]);
  });
});

describe('read check — a record that is not a template envelope', () => {
  it('points at where the stored text stops being JSON', () => {
    const text = '{"name":"horizon.layer.GENERAL","kind":"layer",}';
    const problem = envelopeProblem(text);
    expect(problem.record).toBe(true);
    expect(problem.message).toMatch(/^not valid JSON/);
    expect(problem.offset).toBe(text.indexOf('}'));
  });

  it('points at the end of truncated text', () => {
    const text = '{"name":"horizon.layer.GENERAL","kind":"layer","content":{';
    expect(envelopeProblem(text).offset).toBe(text.length);
  });

  it('names the envelope field that is wrong', () => {
    expect(envelopeProblem('{"name":"horizon.layer.GENERAL","kind":"overview","version":1,"content":{}}')).toMatchObject({
      path: ['kind'],
      record: true,
    });
    expect(envelopeProblem('{"name":"horizon.layer.GENERAL","kind":"layer","version":1}')).toMatchObject({
      path: [],
      message: 'the record has no `content`',
    });
  });
});
