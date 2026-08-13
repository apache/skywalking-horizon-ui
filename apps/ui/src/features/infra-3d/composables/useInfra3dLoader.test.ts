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
 * A run in progress cannot be aborted — the metric chunks it has already sent
 * keep coming back. They must not land on the cubes of whoever is signed in
 * when they do.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { computed, ref } from 'vue';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { bff, type Infra3dConfig } from '@/api/client';
import type { Infra3dMetricsResponse } from '@/api/scopes/infra-3d';
import { resetSessionState } from '@/state/sessionReset';
import { useInfra3dLoader } from './useInfra3dLoader';
import { ensureLoaded as ensureInfra3dConfig, useInfra3dConfig } from './useInfra3dConfig';
import { useInfra3dMetrics } from './useInfra3dMetrics';

const INFRA_CFG: Infra3dConfig = {
  filter: { layer: '.*' },
  edges: {
    hierarchy: { color: '#f0a', style: 'dashed', arrow: true },
    crossLevelCall: { color: '#888', style: 'solid', arrow: true },
    intraCall: { color: '#888', style: 'solid', arrow: false },
  },
  pipeline: {
    metricChunkSize: 50,
    metricConcurrency: 1,
    topologyConcurrency: 2,
    templateConcurrency: 2,
  },
  unknownLayer: { level: 'apps', badge: '#8a8a8a' },
  levels: [{ id: 'apps', order: 0, label: 'Apps', layers: ['GENERAL'] }],
  layers: { GENERAL: { color: '#f60', metric: { mqe: 'service_cpm', label: 'Load', unit: 'cpm' } } },
};

const METRIC_WINDOW = { start: '2026-07-31 1000', end: '2026-07-31 1200', step: 'HOUR' as const };

/** `?live=0` runs the pipeline against the bundled topology snapshot, so the
 *  only OAP call in the run is the metric fan-out under test. */
function snapshotLoader() {
  const cfg = useInfra3dConfig();
  return useInfra3dLoader({
    infraConfig: cfg.config,
    levelsOrdered: cfg.levelsOrdered,
    infraGroups: cfg.groups,
    levelForLayer: cfg.levelForLayer,
    isLayerExcluded: cfg.isLayerExcluded,
    menuLayers: ref<LayerDef[]>([]),
    planeOrder: computed(() => [{ id: 'apps', label: 'Apps' }]),
    liveTopologyEnabled: computed(() => false),
  });
}

/** One macrotask turn drains the whole microtask queue, and every step left in
 *  a run — the stage chain, the awaited chunk mock — is a microtask. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('3D map loader — a metrics chunk that lands after an identity change', () => {
  let cfgFetch: MockInstance<() => Promise<Infra3dConfig>>;

  beforeEach(async () => {
    cfgFetch = vi.spyOn(bff.infra3d, 'config').mockResolvedValue(INFRA_CFG);
    await ensureInfra3dConfig();
  });
  afterEach(() => {
    resetSessionState();
    vi.restoreAllMocks();
  });

  it('does not paint the next operator’s cubes', async () => {
    const metrics = useInfra3dMetrics();
    let land: (r: Infra3dMetricsResponse) => void = () => {};
    let sent: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      sent = resolve;
    });
    vi.spyOn(bff.infra3d, 'metrics').mockImplementation(() => {
      sent();
      return new Promise((resolve) => {
        land = resolve;
      });
    });

    const loader = snapshotLoader();
    loader.start();
    await inFlight;

    resetSessionState();
    land({
      values: { 'GENERAL::agent::songs': 42 },
      errors: {},
      generatedAt: 1,
      window: METRIC_WINDOW,
    });
    // Let the chunk's continuation run — `pipelineRunning` is no help here,
    // the reset already cleared it.
    await flush();
    await flush();

    expect(metrics.values.value.size).toBe(0);
    loader.stopRefresh();
  });

  it('does not blank the next operator’s cubes when it FAILS', async () => {
    const metrics = useInfra3dMetrics();
    let fail: (err: unknown) => void = () => {};
    let sent: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      sent = resolve;
    });
    vi.spyOn(bff.infra3d, 'metrics').mockImplementation(() => {
      sent();
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    });

    const loader = snapshotLoader();
    loader.start();
    await inFlight;

    resetSessionState();
    // A whole-chunk failure marks every node in the chunk null — those keys
    // name the PREVIOUS session's services, and writing them is as much of a
    // leak as writing their values would be.
    fail(new Error('OAP 500'));
    await flush();
    await flush();

    expect(metrics.values.value.size).toBe(0);
    loader.stopRefresh();
  });

  it('does not blank the chips the next operator’s own run just painted', async () => {
    const metrics = useInfra3dMetrics();
    // Drop the preloaded config so run A has something to park on: in snapshot
    // mode every stage before `metrics` is synchronous, and the config read at
    // the top of the pipeline is the run's only other await.
    resetSessionState();
    let landCfg: (c: Infra3dConfig) => void = () => {};
    cfgFetch.mockReturnValueOnce(
      new Promise<Infra3dConfig>((resolve) => {
        landCfg = resolve;
      }),
    );
    vi.spyOn(bff.infra3d, 'metrics').mockResolvedValue({
      values: { 'GENERAL::agent::songs': 42 },
      errors: {},
      generatedAt: 1,
      window: METRIC_WINDOW,
    });

    const loader = snapshotLoader();
    loader.start(); // run A — parked on its config read
    await flush();

    resetSessionState();
    loader.refreshNow(); // run B, under the new identity
    await vi.waitUntil(() => metrics.values.value.size === 1);

    // Run A resumes and walks its stages through to `metrics`, whose FIRST act
    // is to clear the store for its own fan-out.
    landCfg(INFRA_CFG);
    await flush();
    await flush();

    expect(metrics.values.value.get('GENERAL::agent::songs')).toBe(42);
    loader.stopRefresh();
  });
});
