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
import { overviewLayerOptions, widgetLayerKey } from './layerOptions';

describe('overview editor layer options', () => {
  it('upper-cases the layer and keeps a split entry\'s group as written', () => {
    expect(widgetLayerKey('general')).toBe('GENERAL');
    expect(widgetLayerKey('general~payments')).toBe('GENERAL~payments');
    expect(widgetLayerKey('general~Risk-EU')).toBe('GENERAL~Risk-EU');
  });

  it('lists every menu layer and every layer the draft references, once each', () => {
    expect(
      overviewLayerOptions(['mesh', 'general', 'general~payments', 'virtual_genai'], ['GENERAL', undefined, 'k8s', 'general~payments']),
    ).toEqual(['GENERAL', 'GENERAL~payments', 'K8S', 'MESH', 'VIRTUAL_GENAI']);
  });
});
