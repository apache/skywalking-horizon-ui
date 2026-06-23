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
 * URL-backed popout state for Zipkin traces. Shares the native popout's
 * `?traceId=<id>` param; the two self-select by ID shape (Zipkin IDs are
 * bare hex, SkyWalking-native IDs are dotted `x.y.z`), so a layer's
 * `/trace` URL works for either source without a separate param.
 */

import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

export function isZipkinTraceId(id: string): boolean {
  return /^[0-9a-f]{16}$|^[0-9a-f]{32}$/i.test(id);
}

export function useZipkinTracePopout() {
  const route = useRoute();
  const router = useRouter();

  const openTraceId = computed<string | null>(() => {
    const v = route.query.traceId;
    return typeof v === 'string' && isZipkinTraceId(v) ? v : null;
  });

  function openTrace(id: string): void {
    if (!id) return;
    void router.replace({ path: route.path, query: { ...route.query, traceId: id } });
  }

  function closeTrace(): void {
    if (!openTraceId.value) return;
    const next = { ...route.query };
    delete next.traceId;
    void router.replace({ path: route.path, query: next });
  }

  return { openTraceId, openTrace, closeTrace };
}
