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
 * What the translation editor offers for an extension page.
 *
 * The walker is field-name driven, so pages needed no new rule — but that
 * is worth pinning rather than assuming, because the allowlist is also
 * what the editor REBUILDS overlays from. A field it fails to enumerate is
 * not merely hidden from the translator: publishing would delete whatever
 * the seeder had put there.
 */

import { describe, it, expect } from 'vitest';
import { walkTranslatable } from './translatableFields';

const w = (id: string, title: string) => ({ id, type: 'line', title, expressions: ['x'] });

const TEMPLATE = {
  key: 'CUSTOM_MQ',
  alias: 'Custom MQ',
  slots: { services: 'Queues' },
  dashboards: { service: [w('svc-a', 'Throughput')] },
  dashboardExtPages: {
    service: [
      { id: 'resource', name: 'Resource usage', serviceFilter: '/^agent::/', widgets: [w('res-a', 'CPU')] },
    ],
    instance: [{ id: 'runtime', name: 'Runtime', widgets: [w('rt-a', 'Heap')] }],
  },
};

const paths = (src: unknown) => walkTranslatable(src).map((f) => f.path);

describe('walkTranslatable — extension pages', () => {
  it("offers a page's display name", () => {
    expect(paths(TEMPLATE)).toContain('dashboardExtPages.service[0].name');
    expect(paths(TEMPLATE)).toContain('dashboardExtPages.instance[0].name');
  });

  it("offers a page widget's title", () => {
    expect(paths(TEMPLATE)).toContain('dashboardExtPages.service[0].widgets[0].title');
  });

  it('never offers the page id — it is the matching key, not prose', () => {
    expect(paths(TEMPLATE).some((p) => p.endsWith('.id'))).toBe(false);
  });

  it('never offers the service filter — it is a regex over OAP data', () => {
    expect(paths(TEMPLATE).some((p) => p.includes('serviceFilter'))).toBe(false);
  });

  it('groups page fields under their own section, apart from the default grid', () => {
    const byPath = new Map(walkTranslatable(TEMPLATE).map((f) => [f.path, f.section]));
    expect(byPath.get('dashboardExtPages.service[0].name')).not.toBe(
      byPath.get('dashboards.service[0].title'),
    );
  });

  it('stops offering a deleted page, which is what prunes its overlay', () => {
    // The editor rebuilds every overlay from this enumeration, so a page
    // that is gone from the source drops out of the next publish. No
    // separate cleanup step, and no orphan left behind to resurrect if the
    // id is ever reused.
    const without = {
      ...TEMPLATE,
      dashboardExtPages: { instance: TEMPLATE.dashboardExtPages.instance },
    };
    const after = paths(without);
    expect(after.some((p) => p.startsWith('dashboardExtPages.service'))).toBe(false);
    expect(after).toContain('dashboardExtPages.instance[0].name');
    // The component's own grid is untouched by the page's removal.
    expect(after).toContain('dashboards.service[0].title');
  });

  it('offers nothing extra for a template with no pages', () => {
    const plain = { key: 'X', dashboards: { service: [w('a', 'T')] } };
    expect(paths(plain).some((p) => p.includes('dashboardExtPages'))).toBe(false);
  });
});

/**
 * The paths the translation editor addresses a page's fields by.
 *
 * The editor builds these by hand from the selected scope + page, then
 * reads and writes the overlay at them. A wrong prefix does not fail — it
 * silently edits a different widget, or writes a field the merger later
 * ignores, so the operator's typing disappears on publish.
 */
describe('extension-page field addressing', () => {
  const fields = walkTranslatable(TEMPLATE).map((f) => f.path);

  it('addresses a page widget by page INDEX and widget index', () => {
    // The editor composes `dashboardExtPages.<scope>[pageIdx].widgets[i]`;
    // this is the shape the walker actually yields.
    expect(fields).toContain('dashboardExtPages.service[0].widgets[0].title');
  });

  it('addresses the page name at the page prefix, outside its widgets', () => {
    const prefix = 'dashboardExtPages.service[0]';
    const own = fields.filter((p) => p.startsWith(prefix) && !p.startsWith(`${prefix}.widgets[`));
    expect(own).toEqual([`${prefix}.name`]);
  });

  it('keeps each component in its own numbering', () => {
    // Instance pages start at [0] again — an editor that used a global
    // page index would address the wrong component's page.
    expect(fields).toContain('dashboardExtPages.instance[0].name');
  });

  it('never mixes page fields into the default grid prefix', () => {
    const grid = fields.filter((p) => p.startsWith('dashboards.service'));
    expect(grid.every((p) => !p.includes('dashboardExtPages'))).toBe(true);
    expect(grid).toContain('dashboards.service[0].title');
  });
});
