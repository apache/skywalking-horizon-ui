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
import { serviceFilterMatcher, isRegexFilter, countMatches } from './serviceFilter';

/** Raw OAP names, prefixes and all — what the matcher actually sees. */
const NAMES = [
  'agent::checkout',
  'agent::payment',
  'frontend',
  'songs.sample',
  'Cart-Service',
];

const kept = (filter: string) => NAMES.filter(serviceFilterMatcher(filter).match);

describe('service filter — plain terms', () => {
  it('keeps everything when empty', () => {
    expect(serviceFilterMatcher('').empty).toBe(true);
    expect(kept('   ')).toEqual(NAMES);
  });

  it('matches a substring, case-insensitively', () => {
    expect(kept('cart')).toEqual(['Cart-Service']);
    expect(kept('CHECKOUT')).toEqual(['agent::checkout']);
  });

  it('matches against the raw name, prefix included', () => {
    expect(kept('agent::')).toEqual(['agent::checkout', 'agent::payment']);
    expect(kept('sample')).toEqual(['songs.sample']);
  });

  it('treats regex metacharacters literally', () => {
    // A plain term is not a pattern: `.` matches a dot, not any char.
    expect(kept('songs.sample')).toEqual(['songs.sample']);
    expect(kept('songsXsample')).toEqual([]);
  });
});

describe('service filter — /regex/', () => {
  it('recognises the slash-delimited form', () => {
    expect(isRegexFilter('/^agent::/')).toBe(true);
    expect(isRegexFilter('agent')).toBe(false);
    // A lone slash is a term, not an empty pattern.
    expect(isRegexFilter('/')).toBe(false);
  });

  it('anchors on the group prefix — the reason pages can select a group', () => {
    expect(kept('/^agent::/')).toEqual(['agent::checkout', 'agent::payment']);
  });

  it('supports alternation and end anchors', () => {
    expect(kept('/(checkout|frontend)$/')).toEqual(['agent::checkout', 'frontend']);
  });

  it('is case-insensitive, like the plain term', () => {
    expect(kept('/^CART/')).toEqual(['Cart-Service']);
  });

  it('falls back to a literal match when the regex will not compile', () => {
    const m = serviceFilterMatcher('/^(unclosed/');
    expect(m.invalid).toBe(true);
    expect(NAMES.filter(m.match)).toEqual([]);
  });

  it('treats a half-typed pattern as a literal term, so the list only narrows', () => {
    // `/^agent::` has no closing slash yet, so it is still a plain term —
    // and no service name contains that text. The list empties rather than
    // widening back to the full roster, which would read as "filter
    // cleared" at the exact moment the operator is typing one.
    const partial = serviceFilterMatcher('/^agent::');
    expect(partial.invalid).toBe(false);
    expect(NAMES.filter(partial.match)).toEqual([]);
    // Closing the slash turns it into the pattern.
    expect(NAMES.filter(serviceFilterMatcher('/^agent::/').match)).toEqual([
      'agent::checkout',
      'agent::payment',
    ]);
  });
});

describe('countMatches — the admin live count', () => {
  it('counts what the filter keeps', () => {
    expect(countMatches('/^agent::/', NAMES)).toBe(2);
    expect(countMatches('cart', NAMES)).toBe(1);
  });

  it('counts everything for an empty filter', () => {
    expect(countMatches('', NAMES)).toBe(NAMES.length);
  });

  it('counts zero rather than throwing on a broken regex', () => {
    expect(countMatches('/^(nope/', NAMES)).toBe(0);
  });
});
