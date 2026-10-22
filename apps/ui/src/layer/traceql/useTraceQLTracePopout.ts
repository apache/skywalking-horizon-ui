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

/** URL-backed popout for one trace read through a TraceQL datasource, over
 *  any page: `?traceId=` with `?traceType=traceql-<datasource>`, and
 *  `?traceSpanId=` naming a span to select. A layer's TraceQL row opens the
 *  same id itself — with a list beside it — but only from its own datasource,
 *  so the popout stands aside on the row of the datasource it was asked for,
 *  and on no other. */

import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { TraceQLDatasource } from '@skywalking-horizon-ui/api-client';
import { routeRow } from '@/utils/layerRoute';
import { TRACE_POPOUT_QUERY, TRACE_POPOUT_SPAN, TRACE_POPOUT_TYPE, clearTraceAddress, traceStoreOf, withTraceFocus } from '@/layer/traces/tracePopoutQuery';
import { traceqlRowDatasource, traceqlSource, traceqlSourceDatasource } from './traceqlDetailShared';

export function useTraceQLTracePopout() {
  const route = useRoute();
  const router = useRouter();

  const open = computed<{ traceId: string; ds: TraceQLDatasource; spanId: string | null } | null>(() => {
    const id = route.query[TRACE_POPOUT_QUERY];
    const ds = traceqlSourceDatasource(traceStoreOf(route.query));
    if (typeof id !== 'string' || !id || !ds) return null;
    if (traceqlRowDatasource(routeRow(route)) === ds) return null;
    const spanId = route.query[TRACE_POPOUT_SPAN];
    return { traceId: id, ds, spanId: typeof spanId === 'string' && spanId ? spanId : null };
  });

  function openTrace(id: string, ds: TraceQLDatasource, options?: { spanId?: string | null }): void {
    if (!id) return;
    const query = withTraceFocus(
      { ...clearTraceAddress(route.query), [TRACE_POPOUT_QUERY]: id, [TRACE_POPOUT_TYPE]: traceqlSource(ds) },
      { spanId: options?.spanId },
    );
    void router.push({ path: route.path, query });
  }

  function closeTrace(): void {
    if (!open.value) return;
    void router.replace({ path: route.path, query: clearTraceAddress(route.query) });
  }

  return { open, openTrace, closeTrace };
}
