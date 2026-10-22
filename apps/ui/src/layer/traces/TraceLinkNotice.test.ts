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

import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { i18n } from '@/i18n';
import TraceLinkNotice from './TraceLinkNotice.vue';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

async function open(query: string): Promise<{ router: Router; w: VueWrapper }> {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push(`/layer/general/service?${query}`);
  await router.isReady();
  wrapper = mount(TraceLinkNotice, { global: { plugins: [router, i18n] } });
  await flushPromises();
  return { router, w: wrapper };
}

describe('trace link notice', () => {
  it('says a link names no trace source, and offers each one to query', async () => {
    const { w } = await open('traceId=abc');
    expect(w.find('[role="alertdialog"]').exists()).toBe(true);
    expect(w.text()).toContain('abc');
    expect(w.text()).toContain('not set');
    expect(w.findAll('.tln-sources button').map((b) => b.text())).toEqual(['native', 'zipkin', 'traceql-native', 'traceql-zipkin', 'traceql-otlp']);
  });

  it('queries the source picked, on the same link, so its popout takes it', async () => {
    const { router, w } = await open('service=db&traceId=abc&traceType=OTLP&traceAt=1');
    const zipkin = w.findAll('.tln-sources button').find((b) => b.text() === 'zipkin')!;
    await zipkin.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ service: 'db', traceId: 'abc', traceType: 'zipkin', traceAt: '1' });
    expect(w.find('[role="alertdialog"]').exists()).toBe(false);
  });

  it('names a trace source it does not know', async () => {
    const { w } = await open('traceId=abc&traceType=OTLP');
    expect(w.find('.tln-bad').text()).toBe('OTLP');
  });

  it('shows every value of a repeated traceType, an empty one as such', async () => {
    expect((await open('traceId=abc&traceType=native&traceType=zipkin')).w.find('.tln-bad').text()).toBe('native, zipkin');
    wrapper?.unmount();
    expect((await open('traceId=abc&traceType=native&traceType=')).w.find('.tln-bad').text()).toBe('native, ""');
  });

  it('stays closed for a link a popout opens', async () => {
    const { w } = await open('traceId=abc&traceType=zipkin');
    expect(w.find('[role="alertdialog"]').exists()).toBe(false);
  });

  it('closes by clearing the trace from the address, and keeps the rest of it', async () => {
    const { router, w } = await open('service=db&traceId=abc&traceType=tempo&traceAt=1');
    await w.get('button[title="Close"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ service: 'db' });
    expect(w.find('[role="alertdialog"]').exists()).toBe(false);
  });
});
