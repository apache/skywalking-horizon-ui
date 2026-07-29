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
import { pickAnalyzedEvent, summaryEventOrder } from './profiling.js';

describe('pickAnalyzedEvent', () => {
  it('picks the first event when none is requested', () => {
    expect(pickAnalyzedEvent(['CPU', 'ALLOC'], undefined)).toEqual({
      primaryEvent: 'CPU',
      otherEvents: ['ALLOC'],
    });
  });

  it('honours a requested event the task actually captured', () => {
    expect(pickAnalyzedEvent(['CPU', 'ALLOC'], 'ALLOC')).toEqual({
      primaryEvent: 'ALLOC',
      otherEvents: ['CPU'],
    });
  });

  it('falls back to the first event when the requested one was not captured', () => {
    expect(pickAnalyzedEvent(['CPU', 'ALLOC'], 'LOCK')).toEqual({
      primaryEvent: 'CPU',
      otherEvents: ['ALLOC'],
    });
  });

  // CPU / WALL / CTIMER / ITIMER all resolve to the identical EXECUTION_SAMPLE
  // JFR request — a task capturing two of them has ONE dataset, so the sibling
  // must not be offered as "call again to see a different result".
  it('does not name a same-JFR-type sibling as an "other" event', () => {
    expect(pickAnalyzedEvent(['CPU', 'WALL'], undefined)).toEqual({
      primaryEvent: 'CPU',
      otherEvents: [],
    });
  });

  it('drops only the same-JFR siblings, keeping a genuinely different event', () => {
    expect(pickAnalyzedEvent(['CPU', 'WALL', 'ALLOC'], undefined)).toEqual({
      primaryEvent: 'CPU',
      otherEvents: ['ALLOC'],
    });
  });

  it('treats an unrecognised event as its own EXECUTION_SAMPLE-equivalent bucket', () => {
    // Falls back to the same default as CPU/WALL/etc, so it is still
    // recognised as a sibling rather than wrongly listed as "other".
    expect(pickAnalyzedEvent(['CPU', 'SOMETHING_NEW'], undefined)).toEqual({
      primaryEvent: 'CPU',
      otherEvents: [],
    });
  });

  it('has no other events for a single-event task', () => {
    expect(pickAnalyzedEvent(['CPU'], undefined)).toEqual({ primaryEvent: 'CPU', otherEvents: [] });
  });

  // The "other events" must also be deduped AMONG THEMSELVES, not just
  // against the primary — CPU and WALL both resolve to EXECUTION_SAMPLE, so
  // offering both as follow-ups would be two names for the identical result.
  it('dedupes same-JFR-type siblings against each other, not just against the primary', () => {
    expect(pickAnalyzedEvent(['CPU', 'WALL', 'ALLOC'], undefined)).toEqual({
      primaryEvent: 'CPU',
      otherEvents: ['ALLOC'],
    });
  });

  // Inverse of the case above: the PRIMARY is the odd one out (ALLOC), and
  // the two same-JFR siblings (CPU, WALL) are among the "others" — exactly
  // the shape the original bug missed, since the old code only compared each
  // other-event against the PRIMARY's JFR key, never against each other.
  it('dedupes same-JFR-type siblings when the primary is the DIFFERENT event (inverse case)', () => {
    expect(pickAnalyzedEvent(['ALLOC', 'CPU', 'WALL'], 'ALLOC')).toEqual({
      primaryEvent: 'ALLOC',
      otherEvents: ['CPU'],
    });
  });

  it('keeps genuinely distinct events (CPU, LOCK, ALLOC all differ)', () => {
    expect(pickAnalyzedEvent(['ALLOC', 'CPU', 'LOCK'], 'ALLOC')).toEqual({
      primaryEvent: 'ALLOC',
      otherEvents: ['CPU', 'LOCK'],
    });
  });
});

describe('summaryEventOrder', () => {
  // The bug this guards: reusing pickAnalyzedEvent's JFR-deduped `otherEvents`
  // for the task-fact summary made a CPU+WALL task display as "CPU" only —
  // the summary is "what did this task capture", not "what is worth
  // re-analyzing", and those two questions have different answers.
  it('keeps a same-JFR-type sibling that pickAnalyzedEvent would drop', () => {
    expect(summaryEventOrder(['CPU', 'WALL'], 'CPU')).toEqual(['CPU', 'WALL']);
  });

  it('puts the primary event first regardless of its position in the capture list', () => {
    expect(summaryEventOrder(['CPU', 'ALLOC'], 'ALLOC')).toEqual(['ALLOC', 'CPU']);
  });

  it('keeps every event for a task with three or more', () => {
    expect(summaryEventOrder(['CPU', 'WALL', 'ALLOC'], 'CPU')).toEqual(['CPU', 'WALL', 'ALLOC']);
  });

  it('is just the primary event for a single-event task', () => {
    expect(summaryEventOrder(['CPU'], 'CPU')).toEqual(['CPU']);
  });
});
