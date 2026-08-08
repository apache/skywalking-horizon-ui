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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { localizeContent } from '../../i18n/merge.js';
import {
  NODEJS_RUNTIME_METERS_V2_INSERT_IDS,
  looksLikePreInsertTailEntry,
  migrateNodejsRuntimeMetersV2Overlay,
  nodejsRuntimeMetersV2InsertAt,
} from './migrate-overlay.js';

const here = dirname(fileURLToPath(import.meta.url));
const layersDir = join(here, '../../bundled_templates/layers');

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(layersDir, name), 'utf8'));
}

/** Strip the six v2 Node.js overlay slots to simulate a pre-#116 OAP overlay. */
function stripV2Slots(overlay: unknown, insertAt: number): unknown {
  const o = structuredClone(overlay) as {
    dashboards: { instance: unknown[] };
  };
  o.dashboards.instance.splice(insertAt, NODEJS_RUNTIME_METERS_V2_INSERT_IDS.length);
  return o;
}

describe('migrateNodejsRuntimeMetersV2Overlay', () => {
  const source = loadJson('general.json');
  const bundledZh = loadJson('general.i18n.zh-CN.json');
  const insertAt = nodejsRuntimeMetersV2InsertAt(source);

  it('finds the contiguous 6→12 insert in the bundled GENERAL source', () => {
    expect(insertAt).toBeGreaterThan(0);
    const widgets = (source as { dashboards: { instance: { id: string }[] } }).dashboards
      .instance;
    expect(widgets[insertAt - 1]?.id).toBe('nodejs_external_memory');
    expect(widgets[insertAt + NODEJS_RUNTIME_METERS_V2_INSERT_IDS.length]?.id).toBe('jvm_cpu');
  });

  it('is a no-op when overlay length already matches the source', () => {
    const { migrated, content } = migrateNodejsRuntimeMetersV2Overlay(
      source,
      bundledZh,
      bundledZh,
    );
    expect(migrated).toBe(false);
    expect(content).toBe(bundledZh);
  });

  it('inserts six bundled slots and preserves operator customizations around them', () => {
    const oldOverlay = stripV2Slots(bundledZh, insertAt) as {
      dashboards: { instance: Array<{ title?: string; tip?: string }> };
    };
    // Operator customized the first Node.js title and the JVM CPU title on the old overlay.
    oldOverlay.dashboards.instance[3]!.title = '定制进程 CPU';
    oldOverlay.dashboards.instance[insertAt]!.title = '定制 JVM CPU';

    const { migrated, content } = migrateNodejsRuntimeMetersV2Overlay(
      source,
      oldOverlay,
      bundledZh,
    );
    expect(migrated).toBe(true);

    const inst = (content as typeof oldOverlay).dashboards.instance;
    const srcInst = (source as { dashboards: { instance: unknown[] } }).dashboards.instance;
    expect(inst.length).toBe(srcInst.length);
    expect(inst[3]?.title).toBe('定制进程 CPU');
    expect(inst[insertAt + NODEJS_RUNTIME_METERS_V2_INSERT_IDS.length]?.title).toBe(
      '定制 JVM CPU',
    );
    // New slots come from the bundled catalog.
    expect(inst[insertAt]?.title).toBe(
      (bundledZh as typeof oldOverlay).dashboards.instance[insertAt]?.title,
    );
  });

  it('regression: old overlay × new source no longer paints JVM titles on new Node panels', () => {
    const oldOverlay = stripV2Slots(bundledZh, insertAt);
    // Without migration, index merge mis-labels the new panels.
    const broken = localizeContent(source, oldOverlay, 'zh-CN') as {
      dashboards: { instance: Array<{ id: string; title: string }> };
    };
    expect(broken.dashboards.instance[insertAt]?.id).toBe('nodejs_array_buffers');
    expect(broken.dashboards.instance[insertAt]?.title).toBe('JVM CPU');

    const { content: migratedOverlay } = migrateNodejsRuntimeMetersV2Overlay(
      source,
      oldOverlay,
      bundledZh,
    );
    const fixed = localizeContent(source, migratedOverlay, 'zh-CN') as typeof broken;
    expect(fixed.dashboards.instance[insertAt]?.title).toBe('数组缓冲区');
    expect(
      fixed.dashboards.instance[insertAt + NODEJS_RUNTIME_METERS_V2_INSERT_IDS.length]?.title,
    ).toBe('JVM CPU');
  });

  it('is a no-op when the source still lacks the contiguous 6→12 insert', () => {
    const oldSource = structuredClone(source) as {
      dashboards: { instance: Array<{ id: string }> };
    };
    oldSource.dashboards.instance.splice(insertAt, NODEJS_RUNTIME_METERS_V2_INSERT_IDS.length);
    const oldOverlay = stripV2Slots(bundledZh, insertAt);
    const { migrated, content } = migrateNodejsRuntimeMetersV2Overlay(
      oldSource,
      oldOverlay,
      bundledZh,
    );
    expect(migrated).toBe(false);
    expect(content).toBe(oldOverlay);
  });

  it('is a no-op when length is short by exactly 6 but insertAt already looks like a new Node panel', () => {
    // Full new overlay with the last six entries trimmed — length matches the
    // shortfall heuristic, but insertAt still holds a new-Node title.
    const truncated = structuredClone(bundledZh) as {
      dashboards: { instance: unknown[] };
    };
    truncated.dashboards.instance.splice(-NODEJS_RUNTIME_METERS_V2_INSERT_IDS.length);
    const { migrated, content } = migrateNodejsRuntimeMetersV2Overlay(
      source,
      truncated,
      bundledZh,
    );
    expect(migrated).toBe(false);
    expect(content).toBe(truncated);
  });

  it('looksLikePreInsertTailEntry accepts default JVM title and customized non-Node titles', () => {
    const bundled = (bundledZh as { dashboards: { instance: unknown[] } }).dashboards
      .instance;
    const insertCount = NODEJS_RUNTIME_METERS_V2_INSERT_IDS.length;
    expect(
      looksLikePreInsertTailEntry(bundled[insertAt + insertCount], bundled, insertAt, insertCount),
    ).toBe(true);
    expect(
      looksLikePreInsertTailEntry({ title: '定制 JVM CPU' }, bundled, insertAt, insertCount),
    ).toBe(true);
    expect(looksLikePreInsertTailEntry({}, bundled, insertAt, insertCount)).toBe(true);
    expect(
      looksLikePreInsertTailEntry(bundled[insertAt], bundled, insertAt, insertCount),
    ).toBe(false);
  });
});
