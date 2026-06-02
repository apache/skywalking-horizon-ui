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
import {
  buildExportEnvelope,
  buildOverlayExportEnvelope,
  parseOverlayImport,
  validateImport,
} from './templatePortability';

const overview = { id: 'services', title: 'Services', widgets: [] };
const layer = { key: 'mesh', alias: 'Service Mesh' };
const infra3d = { filter: { layer: '.*' }, levels: [], layers: {} };

function env(kind: string, name: string, content: unknown): string {
  return JSON.stringify({ name, kind, version: 1, content });
}

describe('validateImport', () => {
  it('accepts an overview envelope and unwraps to bare content', () => {
    const r = validateImport('overview', env('overview', 'horizon.overview.services', overview));
    expect(r).toEqual({ ok: true, key: 'services', content: overview });
  });

  it('accepts bare overview content, deriving the key from id', () => {
    const r = validateImport('overview', JSON.stringify(overview));
    expect(r.ok && r.key).toBe('services');
    expect(r.ok && r.content).toEqual(overview);
  });

  it('rejects a layer envelope dropped on the overview page (cross-kind)', () => {
    const r = validateImport('overview', env('layer', 'horizon.layer.MESH', layer));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/layer dashboard/);
  });

  it('rejects malformed JSON', () => {
    const r = validateImport('overview', '{ not json');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/valid JSON/);
  });

  it('rejects an overview without a widgets array', () => {
    const r = validateImport('overview', JSON.stringify({ id: 'x', title: 'x' }));
    expect(r.ok).toBe(false);
  });

  it('upper-cases the derived layer key (envelope and bare)', () => {
    expect(validateImport('layer', env('layer', 'horizon.layer.MESH', layer)).ok &&
      (validateImport('layer', env('layer', 'horizon.layer.MESH', layer)) as { key: string }).key).toBe('MESH');
    const bare = validateImport('layer', JSON.stringify(layer));
    expect(bare.ok && bare.key).toBe('MESH');
  });

  it('accepts a 3D-map config and derives the singleton key', () => {
    const r = validateImport('infra-3d', env('infra-3d', 'horizon.infra-3d.config', infra3d));
    expect(r).toEqual({ ok: true, key: 'config', content: infra3d });
  });

  it('rejects a 3D-map config missing levels/layers/filter', () => {
    const r = validateImport('infra-3d', JSON.stringify({ filter: { layer: '.*' } }));
    expect(r.ok).toBe(false);
  });
});

describe('buildExportEnvelope', () => {
  it('wraps content in the canonical { name, kind, version, content } shape', () => {
    expect(buildExportEnvelope('overview', 'horizon.overview.services', overview)).toEqual({
      name: 'horizon.overview.services',
      kind: 'overview',
      version: 1,
      content: overview,
    });
  });
});

const overlay = { title: '服务', widgets: [{ title: '前 20 接口' }] };

describe('parseOverlayImport', () => {
  it('accepts an overlay envelope and reports its template + locale', () => {
    const file = JSON.stringify({
      name: 'horizon.layer.MESH.i18n.zh-CN',
      kind: 'layer',
      version: 1,
      locale: 'zh-CN',
      content: overlay,
    });
    expect(parseOverlayImport(file)).toEqual({
      ok: true,
      kind: 'layer',
      sourceName: 'horizon.layer.MESH',
      locale: 'zh-CN',
      content: overlay,
    });
  });

  it('derives the locale from the name tail when no locale field is set', () => {
    const file = JSON.stringify({
      name: 'horizon.overview.services.i18n.ja',
      kind: 'overview',
      version: 1,
      content: overlay,
    });
    const r = parseOverlayImport(file);
    expect(r.ok && r.locale).toBe('ja');
    expect(r.ok && r.sourceName).toBe('horizon.overview.services');
  });

  it('accepts a bare overlay object with no metadata (targets current selection)', () => {
    const r = parseOverlayImport(JSON.stringify(overlay));
    expect(r.ok).toBe(true);
    expect(r.ok && r.kind).toBeUndefined();
    expect(r.ok && r.content).toEqual(overlay);
  });

  it('rejects a source-template envelope (no locale) as not a translation', () => {
    const file = JSON.stringify({ name: 'horizon.layer.MESH', kind: 'layer', version: 1, content: layer });
    const r = parseOverlayImport(file);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/source template/);
  });

  it('rejects a kind that has no translations (e.g. infra-3d)', () => {
    const file = JSON.stringify({ name: 'horizon.infra-3d.config', kind: 'infra-3d', version: 1, content: {} });
    const r = parseOverlayImport(file);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/overview \/ layer/);
  });

  it('rejects malformed JSON', () => {
    const r = parseOverlayImport('nope');
    expect(r.ok).toBe(false);
  });
});

describe('buildOverlayExportEnvelope', () => {
  it('adds the locale and the .i18n.<locale> name tail', () => {
    expect(buildOverlayExportEnvelope('layer', 'horizon.layer.MESH', 'zh-CN', overlay)).toEqual({
      name: 'horizon.layer.MESH.i18n.zh-CN',
      kind: 'layer',
      version: 1,
      locale: 'zh-CN',
      content: overlay,
    });
  });
});
