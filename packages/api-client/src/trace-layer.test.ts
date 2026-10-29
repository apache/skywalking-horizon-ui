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
import { serviceLayerOf } from './trace.js';

describe('serviceLayerOf', () => {
  it('reads the layer the OTLP store narrows its picker to', () => {
    expect(serviceLayerOf({ stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } }, 'traceql-otlp')).toBe('OTLP_GENERAL');
  });

  it('has none without the setting', () => {
    expect(serviceLayerOf(null, 'traceql-otlp')).toBeNull();
    expect(serviceLayerOf({ sources: ['traceql-otlp'] }, 'traceql-otlp')).toBeNull();
  });

  it('applies to the OTLP store only, whose catalog carries the layer', () => {
    expect(serviceLayerOf({ stores: { 'traceql-native': { serviceLayer: 'GENERAL' } } }, 'traceql-native')).toBeNull();
  });

  it('refuses anything but a layer name, since it is written into a TraceQL expression', () => {
    for (const value of ['otlp_general', 'OTLP_GENERAL"} || {', '', '1LAYER', 'A'.repeat(65)]) {
      expect(serviceLayerOf({ stores: { 'traceql-otlp': { serviceLayer: value } } }, 'traceql-otlp')).toBeNull();
    }
  });
});
