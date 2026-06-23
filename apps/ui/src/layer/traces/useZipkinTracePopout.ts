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

/** URL-backed popout state for Zipkin traces, sharing the native
 *  popout's `?traceId=` param. */

import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useLayers } from '@/shell/useLayers';

// Native vs Zipkin keys on the layer's trace source (route), not the
// ID shape — native IDs can be bare hex, same as Zipkin.
export function useTraceSourceIsZipkin() {
  const route = useRoute();
  const { layers } = useLayers();
  return computed<boolean>(() => {
    if (/\/zipkin-trace(\/|$|\?)/.test(route.path)) return true;
    const key = String(route.params.layerKey ?? '');
    return (layers.value.find((l) => l.key === key)?.traces?.source ?? 'native') === 'zipkin';
  });
}

export function useZipkinTracePopout() {
  const route = useRoute();
  const router = useRouter();
  const sourceIsZipkin = useTraceSourceIsZipkin();

  const openTraceId = computed<string | null>(() => {
    const v = route.query.traceId;
    return typeof v === 'string' && v.length > 0 && sourceIsZipkin.value ? v : null;
  });

  function openTrace(id: string): void {
    if (!id) return;
    void router.replace({ path: route.path, query: { ...route.query, traceId: id } });
  }

  function closeTrace(): void {
    if (!openTraceId.value) return;
    const next = { ...route.query };
    delete next.traceId;
    delete next.traceAt;
    void router.replace({ path: route.path, query: next });
  }

  return { openTraceId, openTrace, closeTrace };
}
