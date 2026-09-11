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

import { computed, ref, type Ref, type WritableComputedRef } from 'vue';

/** A time choice of 0: no window at all, which only a lookup by trace id offers. */
export const NO_TIME_RANGE = 0;

/**
 * The Filter | Trace ID switch of the trace query forms. Each mode keeps its
 * own copy of what both modes show — the time choice and the custom bounds —
 * so switching back finds the filter as it was left.
 */
export function useTraceQueryMode() {
  const queryMode = ref<'filter' | 'traceId'>('filter');
  const isTraceIdMode = computed(() => queryMode.value === 'traceId');
  /** One value held once per mode; reads and writes reach the current mode's. */
  function perMode<T>(filter: Ref<T>, byId: Ref<T>): WritableComputedRef<T> {
    return computed<T>({
      get: () => (isTraceIdMode.value ? byId.value : filter.value),
      set: (v) => {
        if (isTraceIdMode.value) byId.value = v;
        else filter.value = v;
      },
    });
  }
  return { queryMode, isTraceIdMode, perMode };
}
