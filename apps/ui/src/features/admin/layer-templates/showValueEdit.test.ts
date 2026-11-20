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

import { describe, it, expect } from 'vitest';
import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';
import { setShowValueCalculation, setShowValueOption } from './showValueEdit';

const line = (): DashboardWidget => ({ id: 'w', title: 'W', type: 'line', expressions: ['m'] });

describe('showValue editing', () => {
  it('turns the number on with a calculation and off with none', () => {
    const w = line();
    setShowValueCalculation(w, 'latestNotNull');
    expect(w.showValue).toEqual({ calculation: 'latestNotNull' });
    setShowValueCalculation(w, '');
    expect(w.showValue).toBeUndefined();
  });

  it('keeps the options already set when the calculation changes', () => {
    const w = line();
    setShowValueCalculation(w, 'avg');
    setShowValueOption(w, 'layout', 'sideBySide');
    setShowValueOption(w, 'split', '42');
    setShowValueCalculation(w, 'latest');
    expect(w.showValue).toEqual({ calculation: 'latest', layout: 'sideBySide', split: 42 });
  });

  it('stores only what differs from the defaults', () => {
    const w = line();
    setShowValueCalculation(w, 'avg');
    setShowValueOption(w, 'layout', 'stacked');
    setShowValueOption(w, 'topMargin', '40');
    setShowValueOption(w, 'axes', 'hidden');
    expect(w.showValue).toEqual({ calculation: 'avg' });
    setShowValueOption(w, 'topMargin', '12');
    setShowValueOption(w, 'axes', 'shown');
    expect(w.showValue).toEqual({ calculation: 'avg', topMargin: 12, axes: true });
  });

  it('clamps a typed number to what a push accepts, and clears an empty one', () => {
    const w = line();
    setShowValueCalculation(w, 'avg');
    setShowValueOption(w, 'split', '95');
    expect(w.showValue?.split).toBe(70);
    setShowValueOption(w, 'topMargin', '-5');
    expect(w.showValue?.topMargin).toBe(0);
    setShowValueOption(w, 'split', '');
    expect(w.showValue?.split).toBeUndefined();
  });

  it('ignores options while no number is shown', () => {
    const w = line();
    setShowValueOption(w, 'layout', 'sideBySide');
    expect(w.showValue).toBeUndefined();
  });
});
