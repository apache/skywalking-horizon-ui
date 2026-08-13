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
 * Which "no layer here" card a bookmarked `/layer/<key>/…` tab gets. Naming
 * duplication is only honest when the BFF actually hid the layer for that
 * reason, so every case below is about not over-claiming.
 */

import { describe, expect, it } from 'vitest';
import type { TemplateConflict } from '@/api/scopes/configs';
import { layerMissingReason } from './layerMissingReason';

const differing: TemplateConflict = {
  name: 'horizon.layer.GENERAL',
  kind: 'layer',
  key: 'GENERAL',
  enabledIds: ['row-a', 'row-b'],
  identical: false,
};

describe('layerMissingReason', () => {
  it('names the duplicate when the layer’s own template is on two differing records', () => {
    expect(layerMissingReason([differing], 'general')).toBe('duplicated');
  });

  it('reads a split-by-service-group key as its base layer', () => {
    // The sidebar key for a split layer is `<key>~<group>`; the template name
    // is the layer alone, so a bookmarked group entry must resolve the same.
    expect(layerMissingReason([differing], 'general~agent')).toBe('duplicated');
  });

  it('does not claim duplication for a byte-identical duplicate', () => {
    // Those layers stay in the menu, so a missing one went missing for some
    // other reason (admin-disabled, config-excluded, unknown key).
    expect(layerMissingReason([{ ...differing, identical: true }], 'general')).toBe('unknown');
  });

  it('does not claim duplication for another layer’s conflict', () => {
    expect(layerMissingReason([differing], 'mesh')).toBe('unknown');
  });

  it('does not claim duplication for an overview that shares the key', () => {
    const overview: TemplateConflict = {
      name: 'horizon.overview.mesh',
      kind: 'overview',
      key: 'mesh',
      enabledIds: ['row-a', 'row-b'],
      identical: false,
    };
    expect(layerMissingReason([overview], 'mesh')).toBe('unknown');
  });

  it('does not claim duplication for a duplicated translation overlay', () => {
    // Overlay conflicts carry the parent's kind and key; the layer's own
    // definition is still a single record, so it was never hidden.
    const overlay: TemplateConflict = {
      name: 'horizon.layer.GENERAL.i18n.zh-CN',
      kind: 'layer',
      key: 'GENERAL',
      enabledIds: ['row-a', 'row-b'],
      identical: false,
    };
    expect(layerMissingReason([overlay], 'general')).toBe('unknown');
  });

  it('claims nothing without a conflict report — no signal, no cause', () => {
    // Empty is what an unreachable / unread template store reports.
    expect(layerMissingReason([], 'general')).toBe('unknown');
    expect(layerMissingReason(null, 'general')).toBe('unknown');
    expect(layerMissingReason(undefined, 'general')).toBe('unknown');
  });

  it('treats a bundle without the identical flag as the older hide-everything behavior', () => {
    const { identical: _drop, ...legacy } = differing;
    void _drop;
    expect(layerMissingReason([legacy], 'general')).toBe('duplicated');
  });
});
