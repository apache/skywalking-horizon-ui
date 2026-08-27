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
 * The banner is the only place that tells an operator what to DO about a
 * cold-only read, so wrong advice here is worse than none: they follow it,
 * the page stays empty, and they have spent the trust anyway.
 *
 * Two ways it used to be wrong, both from reading `stages.hot` alone:
 *   - with NO cold stage configured — the default BanyanDB build — it still
 *     said "pick an older window", which cannot work, and following it moved
 *     the range out of hot+warm so the banner hid itself;
 *   - with cold configured it used the MIN hot+warm as both the trigger and
 *     the remedy, so the suggested window cleared only the shallowest class.
 */

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import { vi } from 'vitest';

const ttl = ref<unknown>(null);
vi.mock('@/features/operate/ttl/useTtl', () => ({ useTtl: () => ({ data: ttl }) }));
vi.mock('@/shell/useOapInfo', () => ({ useOapInfo: () => ({ backend: ref('banyandb') }) }));

const { useColdStageStore } = await import('@/controls/coldStage');
const { default: ColdStageTrapBanner } = await import('./ColdStageTrapBanner.vue');
const { useTimeRangeStore } = await import('@/controls/timeRange');
const { i18n } = await import('@/i18n');

const DAY = 86_400_000;
/** hot+warm per class; `cold` omitted ⇒ that class has no cold tier. */
function ttlWith(hot: { minute: number; trace: number }, withCold: boolean): unknown {
  const rec = { normal: hot.trace, trace: hot.trace, log: hot.trace, zipkinTrace: hot.trace, browserErrorLog: hot.trace };
  const met = { minute: hot.minute, hour: hot.minute, day: hot.minute, metadata: hot.minute };
  const coldSide = { records: { ...rec }, metrics: { ...met } };
  return { stages: { hot: { records: rec, metrics: met }, cold: withCold ? coldSide : null } };
}

function mountBanner() {
  return mount(ColdStageTrapBanner, { global: { plugins: [createPinia(), i18n] } });
}

describe('the cold-stage trap banner', () => {
  it('does not tell you to pick an older window when there is no cold stage at all', async () => {
    setActivePinia(createPinia());
    ttl.value = ttlWith({ minute: 7, trace: 3 }, false);
    const w = mountBanner();
    useColdStageStore().set(true);
    await w.vm.$nextTick();

    // The only true remedy, and no arithmetic that implies a reachable window.
    expect(w.text()).toContain('no cold stage configured');
    expect(w.text()).not.toContain('Pick a window older than');
  });

  it('stays visible when there is no cold stage, however the range moves', async () => {
    setActivePinia(createPinia());
    ttl.value = ttlWith({ minute: 7, trace: 3 }, false);
    const w = mountBanner();
    useColdStageStore().set(true);
    const time = useTimeRangeStore();
    // Old behaviour: moving out of hot+warm hid the banner, which is exactly
    // what the advice told the operator to do — leaving a blank page and no
    // explanation of it.
    time.selectCustom(Date.now() - 30 * DAY, Date.now() - 29 * DAY, 'HOUR');
    await w.vm.$nextTick();

    expect(w.text()).toContain('Cold-only read is active');
  });

  it('suggests a window that clears the DEEPEST class, not the shallowest', async () => {
    setActivePinia(createPinia());
    // records 3 d, metrics 7 d, both with a cold tier. Warning triggers on 3
    // (something is empty); the remedy has to be 7, or every metric widget
    // stays empty after the operator follows it.
    ttl.value = ttlWith({ minute: 7, trace: 3 }, true);
    const w = mountBanner();
    useColdStageStore().set(true);
    await w.vm.$nextTick();

    expect(w.text()).toContain('3 d');
    expect(w.text()).toContain('7');
  });
});
