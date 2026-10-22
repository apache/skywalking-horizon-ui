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
import { traceRowIsZipkin } from '@skywalking-horizon-ui/api-client';
import { useLayers } from '@/shell/useLayers';
import { resolveEntry, routeRow } from '@/utils/layerRoute';

/** The trace source of this page's own traces, for a link from something
 *  that carries only a trace id — a log row: Zipkin on the Zipkin Traces row
 *  or on a layer whose trace row is Zipkin, native everywhere else. */
export function usePageTraceSource() {
  const route = useRoute();
  const { layers } = useLayers();
  return computed<'native' | 'zipkin'>(() => {
    if (routeRow(route) === 'zipkin-trace') return 'zipkin';
    const layer = route.params.layerKey;
    if (typeof layer !== 'string') return 'native';
    const group = typeof route.params.group === 'string' ? route.params.group : undefined;
    return traceRowIsZipkin(resolveEntry(layers.value, layer, group).def?.traces) ? 'zipkin' : 'native';
  });
}
