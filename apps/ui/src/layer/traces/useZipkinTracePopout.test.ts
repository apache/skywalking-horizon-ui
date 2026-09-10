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
import { zipkinPopoutWindow } from './useZipkinTracePopout';

describe('zipkinPopoutWindow', () => {
  it('takes the list window the id was opened in', () => {
    expect(zipkinPopoutWindow({ traceId: 'a', traceEnd: '1700000000000', traceLookback: '432000000' })).toEqual({ endTs: 1700000000000, lookback: 432000000 });
  });

  it('spans half a day either side of the moment a row gave, as the native popout does', () => {
    expect(zipkinPopoutWindow({ traceId: 'a', traceAt: '1700000000000' })).toEqual({ endTs: 1700000000000 + 43_200_000, lookback: 86_400_000 });
  });

  it('gives nothing for a bare id or a broken hint: unbounded hot, and OAP’s default day when cold', () => {
    expect(zipkinPopoutWindow({ traceId: 'a' })).toBeNull();
    expect(zipkinPopoutWindow({ traceId: 'a', traceEnd: 'soon', traceLookback: '1' })).toBeNull();
    expect(zipkinPopoutWindow({ traceId: 'a', traceEnd: '1700000000000' })).toBeNull();
  });

  it('keeps an explicit zero lookback rather than widening it to the default', () => {
    expect(zipkinPopoutWindow({ traceId: 'a', traceEnd: '1700000000000', traceLookback: '0' })).toEqual({ endTs: 1700000000000, lookback: 0 });
  });
});
