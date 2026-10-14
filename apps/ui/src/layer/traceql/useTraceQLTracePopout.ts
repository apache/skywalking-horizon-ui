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

/** URL-backed popout for one trace read through a TraceQL store, over any
 *  page: `?traceqlId=` with `?ds=` naming the store, as the TraceQL card's
 *  shareable URL writes them. A layer's TraceQL row opens the same id itself
 *  — with a list beside it — but only from its own store, so the popout
 *  stands aside on the row of the store it was asked for, and on no other. */

import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { TraceQLDatasource } from '@skywalking-horizon-ui/api-client';
import { routeRow } from '@/utils/layerRoute';
import { TRACEQL_DS_QUERY, TRACEQL_POPOUT_QUERY, traceqlRowDatasource } from './traceqlDetailShared';

const DATASOURCES: readonly TraceQLDatasource[] = ['native', 'zipkin', 'otlp'];

export function useTraceQLTracePopout() {
  const route = useRoute();
  const router = useRouter();

  const open = computed<{ traceId: string; ds: TraceQLDatasource } | null>(() => {
    const id = route.query[TRACEQL_POPOUT_QUERY];
    const ds = route.query[TRACEQL_DS_QUERY];
    if (typeof id !== 'string' || !id) return null;
    if (typeof ds !== 'string' || !(DATASOURCES as readonly string[]).includes(ds)) return null;
    if (traceqlRowDatasource(routeRow(route)) === ds) return null;
    return { traceId: id, ds: ds as TraceQLDatasource };
  });

  function openTrace(id: string, ds: TraceQLDatasource): void {
    if (!id) return;
    void router.push({ path: route.path, query: { ...route.query, [TRACEQL_POPOUT_QUERY]: id, [TRACEQL_DS_QUERY]: ds } });
  }

  function closeTrace(): void {
    if (!open.value) return;
    const query = { ...route.query };
    delete query[TRACEQL_POPOUT_QUERY];
    delete query[TRACEQL_DS_QUERY];
    void router.replace({ path: route.path, query });
  }

  return { open, openTrace, closeTrace };
}
