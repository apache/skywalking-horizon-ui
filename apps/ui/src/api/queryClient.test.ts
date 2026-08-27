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
 * What the app retries, and what it must not.
 *
 * The two exemptions are easy to lose, because both errors reach this
 * predicate looking like any other rejection — and a retry that should not
 * have happened is invisible except as doubled load on a backend that is
 * already in trouble.
 */

import { describe, expect, it } from 'vitest';
import { queryClient } from './queryClient';
import { BffApiError } from './client';

/** The predicate as the query cache will actually call it. */
function shouldRetry(err: Error, attempt = 0): boolean {
  const retry = queryClient.getDefaultOptions().queries?.retry;
  if (typeof retry !== 'function') throw new Error('retry default is not a predicate');
  return retry(attempt, err) === true;
}

describe('the global retry policy', () => {
  it('retries a genuine transport failure exactly once', () => {
    const err = new Error('Failed to fetch');
    expect(shouldRetry(err, 0)).toBe(true);
    expect(shouldRetry(err, 1)).toBe(false);
  });

  it('never retries an answer that cannot differ', () => {
    // A route that replied 200 with `reachable: false` reached us and said it
    // could not reach OAP. Asking again doubles every request during an outage.
    const err = new Error('OAP could not be reached');
    err.name = 'GraphUnavailableError';
    expect(shouldRetry(err)).toBe(false);
  });

  it('never retries a request WE cancelled', () => {
    // The capped round aborts the fan-out precisely so it stops. A retry here
    // re-issues the request the cancellation existed to stop, which is worse
    // than not capping at all: the work restarts with the cap already spent.
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    expect(shouldRetry(abort)).toBe(false);

    const cancelled = new BffApiError(0, 'request cancelled', null, 'POST', '/api/x', true);
    expect(shouldRetry(cancelled)).toBe(false);
  });

  it('still retries a real BffApiError that we did not cancel', () => {
    const failed = new BffApiError(500, 'POST /api/x failed (500)', null, 'POST', '/api/x');
    expect(shouldRetry(failed, 0)).toBe(true);
  });
});
