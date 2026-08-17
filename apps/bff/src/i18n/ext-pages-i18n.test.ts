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
 * Translating an extension page.
 *
 * A page's display name and its widgets' text are ordinary translatable
 * leaves, so the seeder and the editor already enumerate them. What needed
 * proving is the part that is NOT ordinary: `dashboardExtPages.<scope>` is
 * an array whose entries carry a unique `id`, so the merger addresses it by
 * id — reordering or deleting a page cannot slide a translation onto its
 * neighbour. That is the whole reason page ids must be unique.
 */

import { describe, it, expect } from 'vitest';
import { mergeLocalizedNode, canonicalizeOverlay } from '@skywalking-horizon-ui/api-client';

const w = (id: string, title: string) => ({ id, type: 'line', title, expressions: ['x'] });

function source() {
  return {
    key: 'CUSTOM_MQ',
    dashboards: { service: [w('svc-a', 'Throughput')] },
    dashboardExtPages: {
      service: [
        { id: 'resource', name: 'Resource usage', widgets: [w('res-a', 'CPU')] },
        { id: 'agents', name: 'Agents', widgets: [w('ag-a', 'Agent count')] },
      ],
    },
  };
}

/** A locale overlay addressing both pages by id. */
function overlay() {
  return {
    dashboardExtPages: {
      service: [
        { id: 'resource', name: '资源用量', widgets: [{ id: 'res-a', title: 'CPU 使用率' }] },
        { id: 'agents', name: '探针', widgets: [{ id: 'ag-a', title: '探针数量' }] },
      ],
    },
  };
}

type Merged = {
  dashboardExtPages: { service: Array<{ id: string; name: string; widgets: Array<{ title: string }> }> };
};

describe('extension-page translations', () => {
  it('localizes a page name and its widget titles', () => {
    const out = mergeLocalizedNode(source(), overlay()) as Merged;
    const pages = out.dashboardExtPages.service;
    expect(pages.map((p) => p.name)).toEqual(['资源用量', '探针']);
    expect(pages[0].widgets[0].title).toBe('CPU 使用率');
  });

  it('follows a page when the operator reorders the source', () => {
    const src = source();
    src.dashboardExtPages.service.reverse(); // agents now first
    const out = mergeLocalizedNode(src, overlay()) as Merged;
    expect(out.dashboardExtPages.service.map((p) => p.name)).toEqual(['探针', '资源用量']);
  });

  it('drops the entry for a page that no longer exists, leaving the rest', () => {
    const src = source();
    src.dashboardExtPages.service = src.dashboardExtPages.service.filter((p) => p.id !== 'resource');
    const out = mergeLocalizedNode(src, overlay()) as Merged;
    expect(out.dashboardExtPages.service.map((p) => p.name)).toEqual(['探针']);
  });

  it('never lets an overlay rewrite a page id', () => {
    const bad = {
      dashboardExtPages: { service: [{ id: 'resource', name: '资源用量' }] },
    };
    const out = mergeLocalizedNode(source(), bad) as unknown as {
      dashboardExtPages: { service: Array<{ id: string }> };
    };
    expect(out.dashboardExtPages.service.map((p) => p.id)).toEqual(['resource', 'agents']);
  });

  it('falls back to English for a page the overlay has not translated', () => {
    const partial = {
      dashboardExtPages: { service: [{ id: 'agents', name: '探针' }] },
    };
    const out = mergeLocalizedNode(source(), partial) as Merged;
    expect(out.dashboardExtPages.service.map((p) => p.name)).toEqual(['Resource usage', '探针']);
  });

  it('canonicalizes a legacy positional overlay onto page ids', () => {
    // An overlay written before pages were id-addressed: dense, no ids.
    const positional = {
      dashboardExtPages: { service: [{ name: '资源用量' }, { name: '探针' }] },
    };
    const out = canonicalizeOverlay(source(), positional) as {
      dashboardExtPages: { service: Array<{ id?: string; name?: string }> };
    };
    expect(out.dashboardExtPages.service.map((p) => p.id)).toEqual(['resource', 'agents']);
    // And it still merges to the same result as the id-addressed form.
    expect((mergeLocalizedNode(source(), out) as Merged).dashboardExtPages.service.map((p) => p.name)).toEqual([
      '资源用量',
      '探针',
    ]);
  });

  it('leaves the default page grid untouched by page overlays', () => {
    const out = mergeLocalizedNode(source(), overlay()) as unknown as {
      dashboards: { service: Array<{ title: string }> };
    };
    expect(out.dashboards.service[0].title).toBe('Throughput');
  });
});
