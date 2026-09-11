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

import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';

/**
 * Re-read a trace that answers empty, for a while.
 *
 * A trace's spans land on their own persistence cycle, after whatever named
 * the trace (an evaluation record is written when the judge answers, a log
 * row when it is analysed). A popout opened on something judged seconds ago
 * can therefore read an empty trace that exists a moment later; left alone,
 * "no span data" stands for a trace that is there. This re-reads an empty,
 * un-failed answer every `intervalMs` up to `limit` times while `active`.
 */
export function useEmptyTraceRetry(
  input: {
    /** The popout is open on an id. Going inactive resets the count. */
    active: Ref<boolean>;
    empty: Ref<boolean>;
    /** A read is in flight — never re-read on top of one. */
    busy: Ref<boolean>;
    /** The last answer was a failure to show, not an empty trace to re-read. */
    failed: Ref<boolean>;
    refetch: () => unknown;
  },
  opts: { intervalMs?: number; limit?: number } = {},
) {
  const intervalMs = opts.intervalMs ?? 3_000;
  const limit = opts.limit ?? 10;
  const retries = ref(0);
  let timer: ReturnType<typeof setTimeout> | null = null;
  function stop(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  // Self-driving: each attempt schedules the next once it has settled, so the
  // loop does not depend on the read toggling a source the watch sees.
  function schedule(): void {
    stop();
    if (!input.active.value) { retries.value = 0; return; }
    if (input.busy.value || input.failed.value || !input.empty.value || retries.value >= limit) return;
    timer = setTimeout(async () => {
      timer = null;
      retries.value += 1;
      try { await input.refetch(); } catch { /* the read reports its own failure */ }
      schedule();
    }, intervalMs);
  }
  watch([input.active, input.empty, input.busy, input.failed], schedule, { immediate: true });
  onBeforeUnmount(stop);
  return {
    retries,
    /** True while another read is still coming; the empty state should say so. */
    pending: computed(() => input.active.value && input.empty.value && !input.failed.value && retries.value < limit),
  };
}
