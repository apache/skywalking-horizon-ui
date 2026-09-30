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
import { overviewLayers } from './useOverviewDashboards';

describe('the layers an overview touches', () => {
  it('reads a widget on one service group as its layer', () => {
    expect(overviewLayers({ widgets: [{ layer: 'GENERAL[payments]' }, { layer: 'mesh' }] })).toEqual(['GENERAL', 'MESH']);
  });

  // It gates nothing, so the overview stays listed and the widget says why.
  it('leaves out a widget layer that names no layer', () => {
    expect(overviewLayers({ widgets: [{ layer: 'GENERAL~PAYMENTS' }] })).toEqual([]);
    expect(overviewLayers({ layers: ['K8S'], widgets: [{ layer: 'GENERAL~PAYMENTS' }] })).toEqual(['K8S']);
  });
});
