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
 * The Zipkin search suggestions are shared by the Zipkin Traces tab and Trace
 * inspect's Zipkin mode. Trace inspect passes an empty scope while its Native
 * source is picked, and an empty scope must load nothing; naming one loads the
 * service list and the annotation keys, and a `key=` token swaps the
 * annotation suggestions to that key's values.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { useZipkinAutocomplete } from './useZipkinAutocomplete';

type Suggestions = ReturnType<typeof useZipkinAutocomplete>;

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let asked: string[] = [];
let wrapper: VueWrapper | null = null;

/** Mount the composable the way a page does, with the inputs it binds. */
function mountSuggestions(scope: Ref<string>, annotationQuery: Ref<string>): Suggestions {
  let suggestions: Suggestions | null = null;
  wrapper = mount(defineComponent({
    setup() {
      suggestions = useZipkinAutocomplete({
        layerKey: scope,
        serviceFilter: ref(''),
        annotationQuery,
        spanName: ref(''),
        remoteServiceName: ref(''),
      });
      return () => h('div');
    },
  }));
  if (!suggestions) throw new Error('the composable did not run');
  return suggestions;
}

beforeEach(() => {
  asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://ui');
      asked.push(url.pathname);
      if (url.pathname === '/api/zipkin/services') return jsonResponse(['gateway']);
      if (url.pathname === '/api/zipkin/autocomplete/keys') return jsonResponse(['http.method']);
      if (url.pathname === '/api/zipkin/autocomplete/values') return jsonResponse(['GET', 'POST']);
      return jsonResponse([]);
    }),
  );
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe('useZipkinAutocomplete — the scope decides whether Zipkin is asked at all', () => {
  it('asks nothing of Zipkin while the scope is empty', async () => {
    mountSuggestions(ref(''), ref(''));
    await flushPromises();
    expect(asked).toEqual([]);
  });

  it('loads the services and the annotation keys once a scope is named', async () => {
    const scope = ref('');
    const s = mountSuggestions(scope, ref(''));
    scope.value = 'zipkin';
    await flushPromises();

    expect(asked).toContain('/api/zipkin/services');
    expect(asked).toContain('/api/zipkin/autocomplete/keys');
    expect(s.serviceOptions.value).toEqual(['gateway']);
    expect(s.annotationDatalistOptions.value).toEqual(['http.method']);
  });

  it('offers the values of the key in the last key= term, keeping the terms before it', async () => {
    const annotationQuery = ref('');
    const s = mountSuggestions(ref('zipkin'), annotationQuery);
    await flushPromises();

    annotationQuery.value = 'error http.method=';
    s.onAnnotationInput();
    await flushPromises();

    // A datalist matches and replaces the whole field, so each option keeps `error`.
    expect(s.annotationDatalistOptions.value).toEqual(['error http.method=GET', 'error http.method=POST']);
  });

  it('offers the keys for a new term after the ones already typed', async () => {
    const annotationQuery = ref('');
    const s = mountSuggestions(ref('zipkin'), annotationQuery);
    await flushPromises();

    annotationQuery.value = 'error ';
    expect(s.annotationDatalistOptions.value).toEqual(['error http.method']);
  });

  it('clears the span name and remote service when the service changes to another', async () => {
    const serviceFilter = ref('gateway');
    const spanName = ref('');
    const remoteServiceName = ref('');
    wrapper = mount(defineComponent({
      setup() {
        useZipkinAutocomplete({ layerKey: ref('zipkin'), serviceFilter, annotationQuery: ref(''), spanName, remoteServiceName });
        return () => h('div');
      },
    }));
    await flushPromises();
    spanName.value = 'get /checkout';
    remoteServiceName.value = 'payments';

    serviceFilter.value = 'frontend';
    await flushPromises();

    expect(spanName.value).toBe('');
    expect(remoteServiceName.value).toBe('');
  });
});
