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
 * The service-filter pattern gate.
 *
 * The BFF runs this expression on its event loop, against every service name
 * the store reports, so a pattern that backtracks exponentially stalls every
 * other request. A LENGTH limit does not bound that — `^(a+)+$` is eight
 * characters — which is why the shape is checked rather than the size.
 */

import { describe, expect, it } from 'vitest';
import { backtracksBadly, serviceFilterOf } from './trace.js';

const filter = (pattern: string, flags?: string) =>
  serviceFilterOf({ stores: { 'traceql-native': { serviceFilter: { pattern, ...(flags ? { flags } : {}) } } } }, 'traceql-native');

describe('service filter', () => {
  it('refuses a quantifier applied to a group that repeats or branches', () => {
    for (const p of ['^(a+)+$', '(a*)*', '(a|a)+', '(\\w+\\s?)*', '(a{1,3})+', '((ab)+)+', '^(x|xx)*$']) {
      expect(backtracksBadly(p), p).toBe(true);
      expect(filter(p), p).toBeNull();
    }
  });

  it('refuses a second variable-length quantifier, which multiplies', () => {
    // Not nested, and each one innocent alone: eight of them take over a
    // second on a 100-character name, which the length caps do not bound.
    for (const p of ['^a*a*a*a*a*a*a*a*b$', 'a?a?a?a?a?a?a?a?a?a?b', '[a-z]+::.*', '\\w+\\s+x']) {
      expect(backtracksBadly(p), p).toBe(true);
      expect(filter(p), p).toBeNull();
    }
  });

  it('allows the shapes a service filter is actually written in', () => {
    // One variable quantifier is linear; `{3}` repeats a known number of times
    // and multiplies nothing. The match is a SEARCH, so `^[a-z]+::` is what a
    // rejected `[a-z]+::.*` was trying to say.
    for (const p of ['^agent::', '^(prod|staging)-', 'songs|rating', '^svc-\\d+$', '^a{2,4}$', '(abc)+', '^[a-z]+::', 'agent::(songs|rating)', 'a{3}b']) {
      expect(backtracksBadly(p), p).toBe(false);
      expect(filter(p), p).toBeInstanceOf(RegExp);
    }
  });

  it('survives a pattern that is not valid syntax at all', () => {
    // It runs BEFORE anything tries to compile, so an unbalanced bracket must
    // come back as an answer rather than as a throw in the editor's render.
    for (const p of ['foo)|bar', ')', 'a)*', '(((', '[unclosed', 'a{', 'a{,}']) {
      expect(() => backtracksBadly(p), p).not.toThrow();
      expect(() => filter(p), p).not.toThrow();
    }
  });

  it('does not read a quantifier out of a character class or an escape', () => {
    // `[+*]` is a class of literals, and `\(` is a literal bracket.
    expect(backtracksBadly('^[+*]svc$')).toBe(false);
    expect(backtracksBadly('^\\(a\\)+$')).toBe(false);
  });

  it('refuses a pattern that does not compile, and one that is too long', () => {
    expect(filter('^(unclosed')).toBeNull();
    expect(filter(`^${'a'.repeat(300)}$`)).toBeNull();
  });

  it('carries the flags through, and reads nothing when there is no pattern', () => {
    expect(filter('^agent::', 'i')?.flags).toBe('i');
    expect(filter('')).toBeNull();
    expect(serviceFilterOf(null, 'traceql-native')).toBeNull();
    expect(serviceFilterOf({ sources: ['traceql-native'] }, 'traceql-native')).toBeNull();
  });
});
