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

import { describe, expect, it } from 'vitest';
import { classifySnapshot } from './operate-layers.js';
import type { SyncStatus, TemplateRow } from '../templates/sync.js';
import { formatName } from '../templates/names.js';

function row(key: string, content: Record<string, unknown>, over: Partial<TemplateRow> = {}): TemplateRow {
  return {
    name: formatName('layer', key),
    kind: 'layer',
    key,
    status: 'in-sync',
    effective: 'remote',
    remote: {
      id: key,
      configuration: JSON.stringify({ name: formatName('layer', key), kind: 'layer', version: 1, content }),
      disabled: false,
    },
    bundled: null,
    ...over,
  } as TemplateRow;
}

function sync(rows: TemplateRow[], unreachable = false): SyncStatus {
  return { mode: 'live', unreachable, lastSuccessfulSyncAt: 1, generatedAt: 1, rows, conflicts: [], unreadable: [] } as SyncStatus;
}

describe('operate-layer classification', () => {
  it('reads visibility from the stored template, aliases folded', () => {
    const c = classifySnapshot(sync([row('BANYANDB', { key: 'BANYANDB', visibility: 'operate' }), row('GENERAL', { key: 'GENERAL' })]));
    expect(c.isOperate('banyandb')).toBe(true);
    expect(c.isOperate('GENERAL')).toBe(false);
    expect(c.isOperate('MYSQL')).toBe(false);
  });

  it('keeps a disabled operate layer operate', () => {
    const c = classifySnapshot(
      sync([row('SO11Y_OAP', { key: 'SO11Y_OAP', visibility: 'operate' }, { status: 'disabled', effective: null })]),
    );
    expect(c.isOperate('SO11Y_OAP')).toBe(true);
  });

  it('ignores a row holding another layer\'s template', () => {
    const c = classifySnapshot(sync([row('GENERAL', { key: 'BANYANDB', visibility: 'operate' })]));
    expect(c.isOperate('GENERAL')).toBe(false);
  });

  it('fails closed on an unreachable store: only a retained row still says a layer is ordinary', () => {
    const c = classifySnapshot(sync([row('GENERAL', { key: 'GENERAL' })], true));
    expect(c.isOperate('GENERAL')).toBe(false);
    expect(c.isOperate('MYSQL')).toBe(true);
  });
});
