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
 * Templates change from outside this browser.
 *
 * Another Horizon, swctl, or anything else writing the same OAP store can
 * publish a dashboard, and a store that could not be read can come back.
 * Neither reached a running UI: the bundle was fetched once at mount and never
 * again, so a change appeared only after a reload and an unreachable banner
 * stayed up however healthy OAP had become.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const bundle = vi.fn(async () => null);
vi.mock('@/api/client', () => ({ bffClient: { configs: { bundle } } }));

const { startConfigBundleSync, stopConfigBundleSync } = await import('./configBundle');

beforeEach(() => {
  vi.useFakeTimers();
  bundle.mockClear();
});
afterEach(() => {
  stopConfigBundleSync();
  vi.useRealTimers();
});

describe('the periodic template re-read', () => {
  it('re-reads about once a minute', async () => {
    startConfigBundleSync();
    expect(bundle, 'it fetched immediately — the shell already did that on mount').not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(bundle).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(bundle).toHaveBeenCalledTimes(2);
  });

  it('starts once, however many times it is asked to', async () => {
    startConfigBundleSync();
    startConfigBundleSync();
    startConfigBundleSync();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(bundle, 'a second call added a second timer').toHaveBeenCalledTimes(1);
  });

  it('skips a hidden tab — nobody is looking at those templates', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    startConfigBundleSync();

    await vi.advanceTimersByTimeAsync(180_000);

    expect(bundle).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('stops when told to', async () => {
    startConfigBundleSync();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bundle).toHaveBeenCalledTimes(1);

    stopConfigBundleSync();
    await vi.advanceTimersByTimeAsync(180_000);

    expect(bundle).toHaveBeenCalledTimes(1);
  });
});
