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

import { describe, it, expect, afterEach } from 'vitest';
import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import { getSyncStatus, setTemplateReadOnly, invalidateSyncCache } from './sync.js';
import { iterateBundledTemplates } from './aggregator.js';
import { logger } from '../../logger.js';

// A client that THROWS on any call — proves readonly mode never touches the
// OAP ui_template store (it short-circuits to the disk bundle before list()).
const throwingClient = {
  list: () => Promise.reject(new Error('ui_template store must not be called in readonly mode')),
  create: () => Promise.reject(new Error('no')),
  update: () => Promise.reject(new Error('no')),
  disable: () => Promise.reject(new Error('no')),
} as unknown as UITemplateClient;

const deps = { client: throwingClient, bundled: () => iterateBundledTemplates(), logger };

describe('sync — readonly mode renders from the disk bundle', () => {
  afterEach(() => {
    setTemplateReadOnly(false);
    invalidateSyncCache();
  });

  it('returns mode=readonly + reachable, without calling the ui_template client', async () => {
    setTemplateReadOnly(true);
    const status = await getSyncStatus(deps);
    expect(status.mode).toBe('readonly');
    expect(status.unreachable).toBe(false);
    expect(status.rows.length).toBeGreaterThan(0);
    // Every row is presented as effective:'remote' so every render consumer
    // resolves it exactly as it would a live remote row.
    expect(status.rows.every((r) => r.effective === 'remote' && r.remote !== null)).toBe(true);
  });

  it('includes per-locale translation overlay rows so non-English locales render translated', async () => {
    setTemplateReadOnly(true);
    const status = await getSyncStatus(deps);
    const overlays = status.rows.filter((r) => r.locale !== undefined);
    expect(overlays.length).toBeGreaterThan(0);
    expect(overlays.some((r) => r.locale === 'zh-CN')).toBe(true);
  });

  it('carries the bundled source rows (layer/overview/alert/...) as effective content', async () => {
    setTemplateReadOnly(true);
    const status = await getSyncStatus(deps);
    const kinds = new Set(status.rows.filter((r) => r.locale === undefined).map((r) => r.kind));
    expect(kinds.has('layer')).toBe(true);
    expect(kinds.has('overview')).toBe(true);
  });
});
