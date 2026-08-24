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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { usePodLogTail } from './usePodLogTail';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => { resolve = ok; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('usePodLogTail polling generations', () => {
  it('serializes ticks for one condition but starts a changed condition immediately', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const second = deferred();
    const runOnce = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const invalidateRun = vi.fn();
    const windowSeconds = ref(60);
    let tail!: ReturnType<typeof usePodLogTail>;
    const Host = defineComponent({
      setup() {
        tail = usePodLogTail({
          logSource: ref('pods'),
          canRun: ref(true),
          intervalSeconds: ref(2),
          retargetWatch: [],
          windowWatch: [windowSeconds],
          filterWatch: [],
          hasQueried: ref(false),
          errorMsg: ref(null),
          podErrorReason: ref(null),
          runOnce,
          invalidateRun,
        });
        return () => h('div');
      },
    });
    const wrapper = mount(Host);

    tail.startTail();
    expect(runOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runOnce).toHaveBeenCalledTimes(1);

    windowSeconds.value = 300;
    await nextTick();
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(tail.tailing.value).toBe(true);
    expect(invalidateRun).toHaveBeenCalled();

    second.resolve();
    await Promise.resolve();
    first.resolve();
    await Promise.resolve();
    expect(tail.tailing.value).toBe(true);
    wrapper.unmount();
  });
});
