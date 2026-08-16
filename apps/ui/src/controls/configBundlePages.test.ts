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
 * Reading an extension page's widgets out of the config bundle.
 *
 * The property that matters is what a MISS returns: `null`, so the caller
 * falls through to the network and gets a 404 for a page that does not
 * exist. Returning the component's default grid instead would render real
 * widgets under a URL that promised different ones.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bff } from '@/api/client';
import { getDashboardConfig, isMissingPage, refreshConfigBundle } from '@/controls/configBundle';
import { setPreviewMode } from '@/controls/previewMode';
import { usePreviewOverride } from '@/controls/previewOverride';
import type { ConfigBundle } from '@/api/scopes/configs';

const w = (id: string) => ({ id, title: id, type: 'line' as const, expressions: ['x'] });

const BUNDLE = {
  etag: 'W/"1"',
  generatedAt: 0,
  layers: { custom_mq: { service: [w('svc-default')], instance: [w('inst-default')] } },
  layerExtPages: {
    custom_mq: {
      'service/resource': [w('res-a'), w('res-b')],
      'instance/runtime': [w('rt-a')],
    },
  },
  overviews: [],
  syncStatus: { mode: 'live', unreachable: false, lastSuccessfulSyncAt: null },
} as unknown as ConfigBundle;

/** Load a bundle through the real path — the module keeps its state
 *  private, and a test-only setter would prove less than the code that
 *  actually runs. */
async function load(bundle: ConfigBundle): Promise<void> {
  localStorage.clear();
  vi.spyOn(bff.configs, 'bundle').mockResolvedValue(bundle);
  await refreshConfigBundle({ force: true });
}

describe('getDashboardConfig — extension pages', () => {
  beforeEach(async () => {
    await load(BUNDLE);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('returns the component default when no page is asked for', () => {
    expect(getDashboardConfig('custom_mq', 'service')?.map((x) => x.id)).toEqual(['svc-default']);
  });

  it('returns a named page from its own key', () => {
    expect(getDashboardConfig('custom_mq', 'service', 'resource')?.map((x) => x.id)).toEqual(['res-a', 'res-b']);
    expect(getDashboardConfig('custom_mq', 'instance', 'runtime')?.map((x) => x.id)).toEqual(['rt-a']);
  });

  it('misses — never falls back to the default grid — for an unknown page', () => {
    expect(getDashboardConfig('custom_mq', 'service', 'nope')).toBeNull();
  });

  it('keys pages by component, so one page id cannot answer for another', () => {
    // `runtime` exists under instance only.
    expect(getDashboardConfig('custom_mq', 'service', 'runtime')).toBeNull();
    expect(getDashboardConfig('custom_mq', 'instance', 'resource')).toBeNull();
  });

  it('misses for a layer that declares no pages at all', () => {
    expect(getDashboardConfig('general', 'service', 'resource')).toBeNull();
  });

  it('does not answer a draft-deleted page from the published bundle', async () => {
    // Preview of a draft that declares pages but not this one: the operator
    // deleted it, and rendering its published widgets would say the
    // deletion had not happened.
    const override = usePreviewOverride();
    override.set('horizon.layer.CUSTOM_MQ', {
      key: 'CUSTOM_MQ',
      dashboardExtPages: { service: [{ id: 'kept', name: 'Kept', widgets: [w('k-a')] }] },
    });
    setPreviewMode(true, 'remote');
    try {
      expect(getDashboardConfig('custom_mq', 'service', 'kept')?.map((x) => x.id)).toEqual(['k-a']);
      // `resource` IS in the published bundle — and must not answer here.
      // MISSING_PAGE, not `[]`: an empty array is a real page with no
      // widgets, which renders as a blank dashboard rather than not-found.
      expect(isMissingPage(getDashboardConfig('custom_mq', 'service', 'resource'))).toBe(true);
    } finally {
      setPreviewMode(false);
      override.clear('horizon.layer.CUSTOM_MQ');
    }
  });

  it('does not resurrect a page when the LAST one is deleted', async () => {
    // Deleting the final page removes `dashboardExtPages` entirely, so a
    // draft with no pages at all is the case that matters most — and the
    // one an "if it declares pages" guard misses.
    const override = usePreviewOverride();
    override.set('horizon.layer.CUSTOM_MQ', { key: 'CUSTOM_MQ' });
    setPreviewMode(true, 'remote');
    try {
      expect(isMissingPage(getDashboardConfig('custom_mq', 'service', 'resource'))).toBe(true);
      // The component's DEFAULT grid still comes from the draft/published
      // pair as before — only pages are affected.
      expect(getDashboardConfig('custom_mq', 'service')?.map((x) => x.id)).toEqual(['svc-default']);
    } finally {
      setPreviewMode(false);
      override.clear('horizon.layer.CUSTOM_MQ');
    }
  });

  it('reads a bundle with no layerExtPages block without throwing', async () => {
    await load({ ...BUNDLE, layerExtPages: undefined });
    expect(getDashboardConfig('custom_mq', 'service')?.map((x) => x.id)).toEqual(['svc-default']);
    expect(getDashboardConfig('custom_mq', 'service', 'resource')).toBeNull();
  });
});
