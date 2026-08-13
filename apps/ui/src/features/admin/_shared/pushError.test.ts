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
import { pushErrorLines } from './pushError';

/** Every caller joins these lines into one message, so an empty array is a
 *  blank error on screen — worse than the transport message it replaces. */
describe('pushErrorLines', () => {
  it('renders the BFF issue list, which is the whole message', () => {
    const err = { body: { issues: ['metrics.orderBy: no such column'] }, message: 'POST /x failed (400)' };
    expect(pushErrorLines(err)).toEqual(['metrics.orderBy: no such column']);
  });

  it('falls back to the error message when issues carries no strings', () => {
    const err = { body: { issues: [1, { path: 'x' }] }, message: 'POST /x failed (400)' };
    expect(pushErrorLines(err)).toEqual(['POST /x failed (400)']);
  });

  it('falls back on an empty issue list', () => {
    expect(pushErrorLines({ body: { issues: [] }, message: 'boom' })).toEqual(['boom']);
  });

  it('falls back when there is no body at all', () => {
    expect(pushErrorLines(new Error('network down'))).toEqual(['network down']);
  });

  it('never returns an empty array — the callers join it', () => {
    for (const err of [{ body: { issues: [null] } }, {}, null, 'plain string']) {
      expect(pushErrorLines(err).join(' · ')).not.toBe('');
    }
  });
});
