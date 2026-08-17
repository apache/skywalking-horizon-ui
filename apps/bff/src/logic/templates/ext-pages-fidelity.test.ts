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
 * Unknown fields inside an extension page's widgets are REPORTED.
 *
 * The parse strips them silently, so without this walk the widget renders
 * while quietly missing whatever the author wrote — a defect with no error
 * anywhere. The equivalent walk over `dashboards` has existed for a while;
 * this proves it reaches the new block, including inside tab panels.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBundledTemplates } from './bundled-validate.js';

let root = '';

const widget = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'line',
  title: id,
  expressions: ['service_cpm'],
  ...extra,
});

function writeLayer(content: unknown): void {
  writeFileSync(join(root, 'layers', 'custom_mq.json'), JSON.stringify(content, null, 2));
}

/** Findings for our fixture layer only — the temp root has no singletons,
 *  and those produce their own unrelated findings. */
function layerFindings(): string[] {
  return validateBundledTemplates(root)
    .filter((f) => f.file.includes('custom_mq'))
    .map((f) => `${f.path}: ${f.message}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'horizon-tpl-'));
  mkdirSync(join(root, 'layers'), { recursive: true });
  mkdirSync(join(root, 'overviews'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const BASE = {
  key: 'CUSTOM_MQ',
  slots: { services: 'Queues' },
  components: { service: true },
  dashboards: { service: [widget('svc-a')] },
};

describe('extension-page widget fidelity', () => {
  it('reports nothing for a clean template', () => {
    writeLayer({
      ...BASE,
      dashboardExtPages: { service: [{ id: 'resource', name: 'Resource', widgets: [widget('res-a')] }] },
    });
    expect(layerFindings()).toEqual([]);
  });

  it('reports an unknown field on a page widget', () => {
    writeLayer({
      ...BASE,
      dashboardExtPages: {
        service: [{ id: 'resource', name: 'Resource', widgets: [widget('res-a', { colour: 'red' })] }],
      },
    });
    expect(layerFindings().join(' ')).toContain('dashboardExtPages.service.0.widgets.0');
  });

  it('reports an unknown field nested inside a page tab panel', () => {
    writeLayer({
      ...BASE,
      dashboardExtPages: {
        service: [
          {
            id: 'resource',
            name: 'Resource',
            widgets: [
              {
                id: 'group',
                type: 'tab',
                title: 'T',
                expressions: [],
                tabs: [{ name: 'A', widgets: [widget('leaf', { bogus: 1 })] }],
              },
            ],
          },
        ],
      },
    });
    expect(layerFindings().join(' ')).toContain('tabs.0.widgets.0');
  });

  it('still reports one on the component default grid', () => {
    // The pre-existing walk, unchanged — proving the new one was added
    // beside it rather than in place of it.
    writeLayer({ ...BASE, dashboards: { service: [widget('svc-a', { colour: 'red' })] } });
    expect(layerFindings().join(' ')).toContain('dashboards.service.0');
  });
});
