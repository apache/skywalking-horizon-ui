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
 * `serviceLayer` belongs to the OTLP store alone, the only one whose OAP
 * catalog keeps a layer per service: elsewhere the template schema refuses it
 * and a previewed draft drops it, rather than keep a setting nothing applies.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { layerTemplateSchema } from '../templates/bundled-schema.js';
import { parsePreviewTraces } from './preview.js';

const bundled = JSON.parse(
  readFileSync(new URL('../../bundled_templates/layers/otlp_general.json', import.meta.url), 'utf8'),
) as { traces: Record<string, unknown> };

function withStores(stores: Record<string, unknown>): unknown {
  return { ...bundled, traces: { ...bundled.traces, stores } };
}

describe('service layer of a trace store', () => {
  it('is taken on the OTLP store', () => {
    expect(layerTemplateSchema.safeParse(bundled).success).toBe(true);
    expect(layerTemplateSchema.safeParse(withStores({ 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } })).success)
      .toBe(true);
    expect(parsePreviewTraces('{"stores":{"traceql-otlp":{"serviceLayer":"OTLP_GENERAL"}}}')?.stores)
      .toEqual({ 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } });
  });

  it('is refused on any other store', () => {
    for (const store of ['native', 'zipkin', 'traceql-native', 'traceql-zipkin']) {
      expect(layerTemplateSchema.safeParse(withStores({ [store]: { serviceLayer: 'GENERAL' } })).success, store)
        .toBe(false);
      expect(parsePreviewTraces(`{"stores":{"${store}":{"serviceLayer":"GENERAL"}}}`)?.stores, store).toBeUndefined();
    }
  });
});
