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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useEmptyTraceRetry } from './useEmptyTraceRetry';

function harness() {
  const active = ref(true); const empty = ref(true); const busy = ref(false); const failed = ref(false);
  const refetch = vi.fn();
  let result!: ReturnType<typeof useEmptyTraceRetry>;
  const w = mount(defineComponent({ setup() { result = useEmptyTraceRetry({ active, empty, busy, failed, refetch }, { intervalMs: 1_000, limit: 3 }); return () => h('div'); } }));
  return { active, empty, busy, failed, refetch, result: () => result, w };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

describe('useEmptyTraceRetry', () => {
  it('re-reads an empty answer at the interval, up to the limit, and says so while it will', async () => {
    const { refetch, result, w } = harness();
    expect(result().pending.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000); await nextTick();
    expect(refetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000); await nextTick();
    await vi.advanceTimersByTimeAsync(1_000); await nextTick();
    expect(refetch).toHaveBeenCalledTimes(3);
    expect(result().pending.value).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refetch).toHaveBeenCalledTimes(3);
    w.unmount();
  });

  it('stops once spans arrive, on a failure, or while a read is in flight', async () => {
    const { empty, busy, failed, refetch, result, w } = harness();
    busy.value = true; await nextTick();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refetch).not.toHaveBeenCalled();
    busy.value = false; await nextTick();
    await vi.advanceTimersByTimeAsync(1_000); await nextTick();
    expect(refetch).toHaveBeenCalledTimes(1);
    failed.value = true; await nextTick();
    expect(result().pending.value).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(refetch).toHaveBeenCalledTimes(1);
    failed.value = false; empty.value = false; await nextTick();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(refetch).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it('resets the count when the popout closes, so the next trace gets its own budget', async () => {
    const { active, refetch, result, w } = harness();
    await vi.advanceTimersByTimeAsync(3_000); await nextTick();
    expect(result().retries.value).toBe(3);
    active.value = false; await nextTick();
    expect(result().retries.value).toBe(0);
    active.value = true; await nextTick();
    await vi.advanceTimersByTimeAsync(1_000); await nextTick();
    expect(refetch).toHaveBeenCalledTimes(4);
    w.unmount();
  });
});
