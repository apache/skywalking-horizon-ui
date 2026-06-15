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
import { __evalEntityCompareFlag } from './featureFlags';

describe('__evalEntityCompareFlag', () => {
  it('is on when the env var is "1" or "true"', () => {
    expect(__evalEntityCompareFlag('1', null)).toBe(true);
    expect(__evalEntityCompareFlag('true', null)).toBe(true);
  });

  it('is on when localStorage opts in', () => {
    expect(__evalEntityCompareFlag(undefined, '1')).toBe(true);
    expect(__evalEntityCompareFlag(undefined, 'true')).toBe(true);
  });

  it('is off by default and for non-truthy values', () => {
    expect(__evalEntityCompareFlag(undefined, null)).toBe(false);
    expect(__evalEntityCompareFlag('0', null)).toBe(false);
    expect(__evalEntityCompareFlag('', 'false')).toBe(false);
  });
});
