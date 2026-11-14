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

import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { resolveTraceStores, type TraceStore } from '@skywalking-horizon-ui/api-client';
import { useLayers } from '@/shell/useLayers';
import { findEntry, resolveEntry, routeRow } from '@/utils/layerRoute';

/** The trace store of a view's own traces, for a link from something that
 *  carries only a trace id — a log row: on a layer, its native store when it
 *  has one, else the first store it does have (Zipkin on a Zipkin layer, OTLP
 *  through TraceQL on an OTLP layer); native where no layer is known.
 *  `entryKey` is the menu entry the view reads — a layer, or `layer/group` —
 *  when it is not the route's: a logs block embedded in another page, or the
 *  service picked on Log inspect. Without one, the route decides, and the
 *  Zipkin Traces row is Zipkin. */
export function usePageTraceSource(entryKey?: () => string | null | undefined) {
  const route = useRoute();
  const { layers } = useLayers();
  return computed<TraceStore>(() => {
    const key = entryKey?.();
    let traces;
    if (key) {
      traces = findEntry(layers.value, key)?.traces;
    } else {
      if (routeRow(route) === 'zipkin-trace') return 'zipkin';
      const layer = route.params.layerKey;
      if (typeof layer !== 'string' || !layer) return 'native';
      const group = typeof route.params.group === 'string' ? route.params.group : undefined;
      traces = resolveEntry(layers.value, layer, group).def?.traces;
    }
    const stores = resolveTraceStores(traces);
    return stores.length === 0 || stores.includes('native') ? 'native' : stores[0]!;
  });
}
