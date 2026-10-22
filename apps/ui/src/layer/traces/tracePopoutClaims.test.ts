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

import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { useTracePopout } from './useTracePopout';
import { useZipkinTracePopout } from './useZipkinTracePopout';
import { useTraceQLTracePopout } from '@/layer/traceql/useTraceQLTracePopout';

const Blank = { template: '<div />' };

/** Which popout claims the address — the native, Zipkin and TraceQL ones are
 *  all mounted on every page, so exactly one may answer. */
async function claimedBy(path: string): Promise<string[]> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/layer/:layerKey/service', component: Blank, meta: { layerRow: 'service' } },
      { path: '/layer/:layerKey/zipkin-trace', component: Blank, meta: { layerRow: 'zipkin-trace' } },
      { path: '/operate/trace-inspect', component: Blank },
    ],
  });
  await router.push(path);
  await router.isReady();
  const claims: string[] = [];
  mount(defineComponent({
    setup() {
      const native = useTracePopout();
      const zipkin = useZipkinTracePopout();
      const traceql = useTraceQLTracePopout();
      if (native.openTraceId.value) claims.push('native');
      if (zipkin.openTraceId.value) claims.push('zipkin');
      if (traceql.open.value) claims.push(`traceql:${traceql.open.value.ds}`);
      return () => h('div');
    },
  }), { global: { plugins: [router] } });
  return claims;
}

describe('trace popouts', () => {
  it('open the popout of the trace source the link names, whatever the page', async () => {
    for (const page of ['/layer/general/service', '/layer/mesh/service', '/layer/mesh/zipkin-trace', '/operate/trace-inspect']) {
      expect(await claimedBy(`${page}?traceId=t&traceType=native`), page).toEqual(['native']);
      expect(await claimedBy(`${page}?traceId=t&traceType=zipkin`), page).toEqual(['zipkin']);
      expect(await claimedBy(`${page}?traceId=t&traceType=traceql-otlp`), page).toEqual(['traceql:otlp']);
      expect(await claimedBy(`${page}?traceId=t&traceType=traceql-native`), page).toEqual(['traceql:native']);
      expect(await claimedBy(`${page}?traceId=t&traceType=traceql-zipkin`), page).toEqual(['traceql:zipkin']);
    }
  });

  it('leave a link that names no source, or one they do not know, to the notice', async () => {
    for (const query of ['traceId=t', 'traceId=t&traceType=OTLP', 'traceId=t&traceType=SKYWALKING_NATIVE', 'traceId=t&source=zipkin']) {
      expect(await claimedBy(`/layer/mesh/zipkin-trace?${query}`), query).toEqual([]);
      expect(await claimedBy(`/layer/general/service?${query}`), query).toEqual([]);
    }
  });
});
