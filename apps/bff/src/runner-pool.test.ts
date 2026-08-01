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
import { isMainThread } from 'node:worker_threads';

/** The unit suite runs under vitest's `threads` pool, pinned in the `test:unit`
 *  script; this asserts the pin took.
 *
 *  Vitest defaults to `forks`, where every test file owns a process — so a
 *  `process.env.TZ` write really does move what `Date` answers, and two files'
 *  queued fs writes never contend for one libuv threadpool. Neither holds in a
 *  worker thread, which is why the host-zone (`util/time`, `util/window`) and
 *  wire-log stream flakes were invisible until the suite ran under `threads`.
 *  Lose the pin and that whole class is out of CI's reach again. */
describe('unit-suite runner', () => {
  it('runs test files in worker threads, not forked processes', () => {
    expect(isMainThread).toBe(false);
  });
});
