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
 * Nothing an operator's session read may outlive that session. Every
 * registrant is exercised through the ONE seam the auth store calls, because
 * a cache that forgets to register is exactly the failure this guards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { bff, type AlarmsResponse, type Infra3dConfig } from '@/api/client';
import { queryClient } from '@/api/queryClient';
import { pushEvent, useEventLog } from '@/controls/eventLog';
import { ensureConfigBundle, refreshConfigBundle, useConfigBundle } from '@/controls/configBundle';
import { useAiConversations } from '@/ai/useAiConversations';
import { useInfra3dAlarms } from '@/features/infra-3d/composables/useInfra3dAlarms';
import {
  ensureLoaded as ensureInfra3dConfig,
  useInfra3dConfig,
} from '@/features/infra-3d/composables/useInfra3dConfig';
import { setValues, valueFor } from '@/features/infra-3d/composables/useInfra3dMetrics';
import {
  run as runPipeline,
  useInfra3dPipeline,
  type PipelineStageId,
  type StageImpl,
} from '@/features/infra-3d/composables/useInfra3dPipeline';
import { useLayerSelectionStore } from './layerSelection';
import { onSessionReset, resetSessionState } from './sessionReset';

/** One macrotask turn drains the whole microtask queue, which is all a
 *  superseded read has left to run once its response is handed over. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('resetSessionState — the Vue Query cache', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    queryClient.clear();
  });

  it('REMOVES cached responses rather than marking them stale', () => {
    queryClient.setQueryData(['services', 'GENERAL'], [{ name: 'payments' }]);
    queryClient.setQueryData(['alarms'], { msgs: [{ id: 'a1' }] });

    resetSessionState();

    expect(queryClient.getQueryData(['services', 'GENERAL'])).toBeUndefined();
    expect(queryClient.getQueryData(['alarms'])).toBeUndefined();
    // Not merely invalidated: an invalidated `staleTime: Infinity` query would
    // still hand its data to the next observer that mounts.
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('a request in flight under the old identity cannot repopulate the cache', async () => {
    let release: (rows: unknown) => void = () => {};
    const inFlight = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const fetching = queryClient
      .fetchQuery({ queryKey: ['traces'], queryFn: () => inFlight })
      .catch(() => undefined);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);

    resetSessionState();
    // The old session's response lands AFTER the identity changed.
    release([{ traceId: 'user-a-trace' }]);
    await fetching;

    expect(queryClient.getQueryData(['traces'])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('drops the debug event log (the previous session\'s routes and API errors)', () => {
    pushEvent('route', 'info', 'Navigated to /layer/GENERAL/trace');
    expect(useEventLog().all.value).not.toHaveLength(0);

    resetSessionState();

    expect(useEventLog().all.value).toHaveLength(0);
  });

  it('runs every registered module reset', () => {
    const spy = vi.fn();
    onSessionReset(spy);

    resetSessionState();
    resetSessionState();

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a registrant that throws neither skips its siblings nor rejects the caller', () => {
    const after = vi.fn();
    // Registrants live for the module's lifetime, so this one arms once —
    // later tests in this file reset too, and a permanently-throwing
    // registrant would just add noise to them.
    let armed = true;
    onSessionReset(() => {
      if (!armed) return;
      armed = false;
      throw new Error('registrant blew up');
    });
    onSessionReset(after);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    // logout() awaits this before routing to the login page: a throw here
    // would leave the operator on a page whose session is already gone.
    expect(() => resetSessionState()).not.toThrow();

    expect(after).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('resetSessionState — the config bundle', () => {
  const bundle = {
    etag: 'W/"1"',
    generatedAt: 1,
    layers: { general: { service: [] } },
    overviews: [],
    syncStatus: {
      mode: 'live',
      unreachable: false,
      lastSuccessfulSyncAt: 1,
      generatedAt: 1,
      badges: [],
      conflicts: [],
    },
  };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => bundle,
    }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops the loaded bundle AND its one-shot load, so the next session re-reads it', async () => {
    await ensureConfigBundle();
    expect(useConfigBundle().bundle.value).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resetSessionState();
    expect(useConfigBundle().bundle.value).toBeNull();
    expect(useConfigBundle().loaded.value).toBe(false);

    await ensureConfigBundle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a bundle fetch already in flight cannot publish after the switch', async () => {
    // The load is one-shot per module: start from a clean slate so this test
    // exercises a real fetch rather than an earlier test's settled promise.
    resetSessionState();
    let land: (r: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );

    const loading = ensureConfigBundle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resetSessionState();
    // The previous session's bundle answers after the identity changed.
    land({ status: 200, ok: true, json: async () => bundle });
    await loading;

    expect(useConfigBundle().bundle.value).toBeNull();
    // …and it must not seed the localStorage copy the next session reads.
    expect(localStorage.getItem('horizon:configBundle:v3')).toBeNull();
  });

  it('a bundle fetch that FAILS after the switch cannot seed the unreachable placeholder', async () => {
    resetSessionState();
    let fail: (err: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );

    const loading = ensureConfigBundle();
    resetSessionState();
    fail(new Error('network down'));
    await loading;

    // The failure path seeds an empty `unreachable` bundle so the shell stops
    // waiting on "Initializing…". Applied for a session that is already gone,
    // that flips `loaded` true for the NEW one: every layer route renders
    // empty behind the connectivity banner, and the fetch that would have
    // filled them is the one-shot load this response just consumed.
    expect(useConfigBundle().bundle.value).toBeNull();
    expect(useConfigBundle().loaded.value).toBe(false);
  });

  it('a forced refresh in flight cannot overwrite the cache the next session seeds from', async () => {
    resetSessionState();
    await ensureConfigBundle();
    expect(useConfigBundle().bundle.value).not.toBeNull();

    let land: (r: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    // Every admin page force-refreshes the bundle on mount, so this is the
    // read most likely to still be in flight when an operator signs out.
    const refreshing = refreshConfigBundle({ force: true });
    resetSessionState();
    land({ status: 200, ok: true, json: async () => ({ ...bundle, etag: 'W/"2"' }) });
    await refreshing;

    expect(useConfigBundle().bundle.value).toBeNull();
    const cached = JSON.parse(localStorage.getItem('horizon:configBundle:v3')!) as { etag: string };
    expect(cached.etag).toBe('W/"1"');
  });
});

describe('resetSessionState — the AI transcript', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('drops the in-memory conversations the previous operator was reading', () => {
    const conv = useAiConversations();
    conv.newChat();
    expect(conv.conversations.value).toHaveLength(1);
    expect(conv.currentId.value).not.toBeNull();

    resetSessionState();

    expect(conv.conversations.value).toHaveLength(0);
    expect(conv.currentId.value).toBeNull();
    expect(conv.current.value).toBeNull();
  });
});

describe('resetSessionState — the layer selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('drops the previous operator’s pick and their locked compare set', () => {
    const sel = useLayerSelectionStore();
    sel.resetForLayer('GENERAL', { service: 'svc.payments' });
    sel.setInstance('payments-7d9f');
    sel.toggleLock('service', 'svc.payments');
    expect(sel.activeCompareSet('service')).toHaveLength(1);

    resetSessionState();

    expect(sel.service).toBeNull();
    expect(sel.instance).toBeNull();
    expect(sel.ownerKey).toBeNull();
    expect(sel.activeCompareSet('service')).toHaveLength(0);
  });
});

/**
 * `/3d/map` carries no route verb, so a new operator can open it the moment
 * they sign in — before any of its own reads land. Everything the map paints
 * from lives in a module singleton, and the map's own loading pipeline clears
 * only some of it, only at its last stage.
 */
describe('resetSessionState — the 3D infrastructure map', () => {
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
    unknownLayer: { level: 'infra', badge: '#8a8a8a' },
    levels: [{ id: 'apps', order: 0, label: 'Apps', layers: ['GENERAL'] }],
    layers: { GENERAL: { color: '#f60', metric: { mqe: 'service_cpm', label: 'Load', unit: 'cpm' } } },
  };

  function alarmsResponse(names: string[]): AlarmsResponse {
    return {
      returned: names.length,
      pageNum: 1,
      pageSize: 500,
      truncated: false,
      generatedAt: 1,
      msgs: names.map((name, i) => ({
        id: `alarm-${i}`,
        startTime: 1,
        recoveryTime: null,
        scope: 'Service' as const,
        name,
        message: 'Response time > 1s',
        tags: [],
        snapshot: { expression: '', metrics: [] },
        layerKey: 'GENERAL',
      })),
    };
  }

  /** A pipeline whose first stage parks until `stalled` settles; the rest are
   *  no-ops, so the run finishes on the same turn it resumes. */
  function stallingImpls(stalled: Promise<void>): Record<PipelineStageId, StageImpl<unknown>> {
    const noop: StageImpl<unknown> = async () => {};
    return {
      services: async (rep) => {
        rep.start();
        await stalled;
        rep.ok('65 services / 17 layers', {
          kind: 'services',
          servicesTotal: 65,
          layersTotal: 17,
          addedSince: null,
          removedSince: null,
        });
      },
      templates: noop,
      topologies: noop,
      hierarchy: noop,
      layout: noop,
      metrics: noop,
    };
  }

  /** The alarm poll is refcounted on mount, so it needs a real component. */
  function mountAlarms() {
    let alarms!: ReturnType<typeof useInfra3dAlarms>;
    const Host = defineComponent({
      setup() {
        alarms = useInfra3dAlarms();
        return () => h('div');
      },
    });
    const wrapper = mount(Host);
    return { alarms, wrapper };
  }

  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('empties the alarmed-service sets that redden the cubes', async () => {
    vi.spyOn(bff.alarms, 'list').mockResolvedValue(alarmsResponse(['payments', 'orders']));
    const { alarms, wrapper } = mountAlarms();
    await vi.waitUntil(() => alarms.alarmedKeys.value.size === 2);

    resetSessionState();

    expect(alarms.alarmedKeys.value.size).toBe(0);
    expect(alarms.alarmedNamesNoLayer.value.size).toBe(0);
    expect(alarms.lastUpdatedAt.value).toBeNull();
    wrapper.unmount();
  });

  it('an alarm poll in flight cannot repopulate the sets after the switch', async () => {
    let land: (r: AlarmsResponse) => void = () => {};
    vi.spyOn(bff.alarms, 'list').mockReturnValue(
      new Promise<AlarmsResponse>((resolve) => {
        land = resolve;
      }),
    );
    const { alarms, wrapper } = mountAlarms();

    resetSessionState();
    land(alarmsResponse(['payments']));
    await new Promise((r) => setTimeout(r, 0));

    expect(alarms.alarmedKeys.value.size).toBe(0);
    wrapper.unmount();
  });

  it('drops the map config, so the next session re-reads it (and can be refused it)', async () => {
    const cfgFetch = vi.spyOn(bff.infra3d, 'config').mockResolvedValue(INFRA_CFG);
    await ensureInfra3dConfig();
    expect(useInfra3dConfig().config.value).not.toBeNull();

    resetSessionState();
    expect(useInfra3dConfig().config.value).toBeNull();

    // The view gates the whole page on this call: cached, it never asks, so a
    // role without `infra-3d:read` would be shown the map instead of the 403.
    await ensureInfra3dConfig();
    expect(cfgFetch).toHaveBeenCalledTimes(2);
  });

  it('a map-config fetch in flight cannot publish after the switch', async () => {
    // `ensureLoaded` short-circuits on a loaded snapshot, so drop whatever a
    // previous test left behind — otherwise nothing is in flight to test.
    resetSessionState();
    let land: (c: Infra3dConfig) => void = () => {};
    const cfgFetch = vi.spyOn(bff.infra3d, 'config').mockReturnValue(
      new Promise<Infra3dConfig>((resolve) => {
        land = resolve;
      }),
    );

    const loading = ensureInfra3dConfig();
    expect(cfgFetch).toHaveBeenCalledTimes(1);
    resetSessionState();
    land(INFRA_CFG);
    await loading;

    expect(useInfra3dConfig().config.value).toBeNull();
  });

  it('empties the per-cube metric chips', () => {
    setValues({ 'GENERAL::payments': 42 });
    expect(valueFor('GENERAL', 'payments')).toBe(42);

    resetSessionState();

    expect(valueFor('GENERAL', 'payments')).toBeUndefined();
  });

  it('puts the loading timeline back to idle', async () => {
    const { stages } = useInfra3dPipeline();
    vi.spyOn(bff.infra3d, 'config').mockResolvedValue(INFRA_CFG);
    const noop: StageImpl<unknown> = async () => {};
    const impls = {
      services: async (rep) => {
        rep.ok('65 services / 17 layers', {
          kind: 'services',
          servicesTotal: 65,
          layersTotal: 17,
          addedSince: null,
          removedSince: null,
        });
      },
      templates: noop,
      topologies: noop,
      hierarchy: noop,
      layout: noop,
      metrics: noop,
    } satisfies Record<PipelineStageId, StageImpl<unknown>>;

    await runPipeline({}, impls);
    expect(stages.value.services.summary).toBe('65 services / 17 layers');

    resetSessionState();

    expect(stages.value.services.status).toBe('idle');
    expect(stages.value.services.summary).toBe('');
  });

  it('a stage that finishes after the switch cannot write into the fresh timeline', async () => {
    const { stages } = useInfra3dPipeline();
    vi.spyOn(bff.infra3d, 'config').mockResolvedValue(INFRA_CFG);
    let land: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      land = resolve;
    });
    const impls = stallingImpls(stalled);

    const running = runPipeline({}, impls);
    resetSessionState();
    land();
    await running;

    expect(stages.value.services.status).toBe('idle');
    expect(stages.value.services.summary).toBe('');
  });

  it('a run that finishes after the switch cannot stamp the fresh timeline as completed', async () => {
    const { completedAt } = useInfra3dPipeline();
    vi.spyOn(bff.infra3d, 'config').mockResolvedValue(INFRA_CFG);
    let land: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      land = resolve;
    });

    const running = runPipeline({}, stallingImpls(stalled));
    resetSessionState();
    land();
    await running;

    // An idle timeline stamped with a completion time reads as "this is what
    // your session loaded", which is exactly what it is not.
    expect(completedAt.value).toBeNull();
  });

  it('a run that finishes after the switch does not release the latch the new run holds', async () => {
    const { running } = useInfra3dPipeline();
    vi.spyOn(bff.infra3d, 'config').mockResolvedValue(INFRA_CFG);
    let landOld: () => void = () => {};
    const oldStage = new Promise<void>((resolve) => {
      landOld = resolve;
    });
    const oldRun = runPipeline({}, stallingImpls(oldStage));
    await flush();

    resetSessionState();
    let landNew: () => void = () => {};
    const newStage = new Promise<void>((resolve) => {
      landNew = resolve;
    });
    const newRun = runPipeline({}, stallingImpls(newStage));
    await flush();
    expect(running.value).toBe(true);

    landOld();
    await oldRun;

    // `run()` is a no-op while the latch is held: released by a run nobody is
    // watching, the next refresh fans out a second set of OAP calls alongside
    // the one still in flight, and the strip stops reporting the live run.
    expect(running.value).toBe(true);

    landNew();
    await newRun;
    expect(running.value).toBe(false);
  });

  it('an alarm poll that FAILS after the switch cannot raise its error on the new session', async () => {
    let fail: (err: unknown) => void = () => {};
    vi.spyOn(bff.alarms, 'list').mockReturnValue(
      new Promise<AlarmsResponse>((_resolve, reject) => {
        fail = reject;
      }),
    );
    const { alarms, wrapper } = mountAlarms();

    resetSessionState();
    fail(new Error('OAP unreachable'));
    await flush();

    expect(alarms.error.value).toBeNull();
    wrapper.unmount();
  });

  it('a superseded alarm poll does not free the slot the new session’s poll owns', async () => {
    let landOld: (r: AlarmsResponse) => void = () => {};
    const list = vi.spyOn(bff.alarms, 'list');
    list.mockReturnValueOnce(
      new Promise<AlarmsResponse>((resolve) => {
        landOld = resolve;
      }),
    );
    const { alarms, wrapper } = mountAlarms();
    expect(list).toHaveBeenCalledTimes(1);

    resetSessionState();
    let landNew: (r: AlarmsResponse) => void = () => {};
    list.mockReturnValueOnce(
      new Promise<AlarmsResponse>((resolve) => {
        landNew = resolve;
      }),
    );
    void alarms.refresh();
    expect(list).toHaveBeenCalledTimes(2);

    landOld(alarmsResponse(['payments']));
    await flush();

    // The slot is what makes concurrent callers share one poll. Freed by the
    // superseded one, the next caller starts a duplicate alongside the live one.
    void alarms.refresh();
    expect(list).toHaveBeenCalledTimes(2);

    landNew(alarmsResponse([]));
    await flush();
    wrapper.unmount();
  });

  it('a map-config fetch that FAILS after the switch cannot raise its error on the new session', async () => {
    resetSessionState();
    let fail: (err: unknown) => void = () => {};
    vi.spyOn(bff.infra3d, 'config').mockReturnValue(
      new Promise<Infra3dConfig>((_resolve, reject) => {
        fail = reject;
      }),
    );

    const loading = ensureInfra3dConfig().catch(() => undefined);
    resetSessionState();
    fail(new Error('403 forbidden'));
    await loading;

    expect(useInfra3dConfig().error.value).toBeNull();
  });

  it('a superseded map-config fetch does not clear the new session’s loading flag or slot', async () => {
    resetSessionState();
    const cfgFetch = vi.spyOn(bff.infra3d, 'config');
    let landOld: (c: Infra3dConfig) => void = () => {};
    cfgFetch.mockReturnValueOnce(
      new Promise<Infra3dConfig>((resolve) => {
        landOld = resolve;
      }),
    );
    const old = ensureInfra3dConfig();
    expect(cfgFetch).toHaveBeenCalledTimes(1);

    resetSessionState();
    let landNew: (c: Infra3dConfig) => void = () => {};
    cfgFetch.mockReturnValueOnce(
      new Promise<Infra3dConfig>((resolve) => {
        landNew = resolve;
      }),
    );
    const fresh = ensureInfra3dConfig();
    expect(cfgFetch).toHaveBeenCalledTimes(2);
    expect(useInfra3dConfig().loading.value).toBe(true);

    landOld(INFRA_CFG);
    await old;

    // The view gates the scene on this pair: cleared early, it mounts a map
    // with no config, and the freed slot lets the next caller re-fetch.
    expect(useInfra3dConfig().loading.value).toBe(true);
    void ensureInfra3dConfig();
    expect(cfgFetch).toHaveBeenCalledTimes(2);

    landNew(INFRA_CFG);
    await fresh;
    expect(useInfra3dConfig().loading.value).toBe(false);
    resetSessionState();
  });
});
