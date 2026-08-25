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
 * The instance set a page declares.
 *
 * The conditions AND, and the attribute half must agree with the widget
 * gate that reads the same bag — an `exists` that meant merely-present
 * here and present-and-non-empty there would show an instance whose
 * widgets then all hid themselves.
 */

import { describe, it, expect } from 'vitest';
import { instancePageMatcher, isEmptyInstanceFilter } from './instancePageFilter';
import type { LayerInstance } from './useInstanceCascade';

const inst = (name: string, language: string | null, attrs: Record<string, string> = {}): LayerInstance => ({
  id: name,
  name,
  language,
  attributes: Object.entries(attrs).map(([k, v]) => ({ name: k, value: v })),
});

const LIST: LayerInstance[] = [
  inst('broker-1', 'java', { namespace: 'prod', region: 'eu' }),
  inst('broker-2', 'java', { namespace: '' }),
  inst('worker-1', 'go', { namespace: 'prod' }),
  inst('broker-3', 'Java', { Namespace: 'staging' }),
];
const names = (f: Parameters<typeof instancePageMatcher>[0]) => LIST.filter(instancePageMatcher(f)).map((i) => i.name);

describe('a page with no filter', () => {
  it('takes every instance', () => {
    expect(isEmptyInstanceFilter(undefined)).toBe(true);
    expect(names(undefined)).toEqual(['broker-1', 'broker-2', 'worker-1', 'broker-3']);
    expect(names({ instanceAttributes: [] })).toHaveLength(4);
  });
});

describe('the name half', () => {
  it('matches a bare term as a case-insensitive substring', () => {
    expect(names({ instanceFilter: 'BROKER' })).toEqual(['broker-1', 'broker-2', 'broker-3']);
  });

  it('matches a /…/ term as a regular expression', () => {
    expect(names({ instanceFilter: '/^broker-[12]$/' })).toEqual(['broker-1', 'broker-2']);
  });

  it('falls back to a literal when the regex is invalid, never widening', () => {
    expect(names({ instanceFilter: '/(unclosed/' })).toEqual([]);
  });
});

describe('the attribute half', () => {
  it('matches a value case-insensitively, key and value alike', () => {
    expect(names({ instanceAttributes: [{ attribute: 'Namespace', op: 'eq', value: 'PROD' }] })).toEqual([
      'broker-1',
      'worker-1',
    ]);
  });

  it('treats language as an attribute, as the widget gate does', () => {
    expect(names({ instanceAttributes: [{ attribute: 'language', op: 'eq', value: 'java' }] })).toEqual([
      'broker-1',
      'broker-2',
      'broker-3',
    ]);
  });

  it('reads an empty value as absent — OAP reports unset attributes that way', () => {
    // broker-2 carries `namespace: ''`. Counting it as present would make
    // `exists` match every instance and look broken.
    expect(names({ instanceAttributes: [{ attribute: 'namespace', op: 'exists' }] })).toEqual([
      'broker-1',
      'worker-1',
      'broker-3',
    ]);
  });

  it('ANDs its conditions with each other', () => {
    expect(
      names({
        instanceAttributes: [
          { attribute: 'language', op: 'eq', value: 'java' },
          { attribute: 'namespace', op: 'exists' },
        ],
      }),
    ).toEqual(['broker-1', 'broker-3']);
  });
});

describe('both halves together', () => {
  it('ANDs the name with the attributes', () => {
    expect(
      names({
        instanceFilter: '/^broker-/',
        instanceAttributes: [{ attribute: 'namespace', op: 'eq', value: 'staging' }],
      }),
    ).toEqual(['broker-3']);
  });

  it('yields nothing when they cannot both hold', () => {
    // The page is simply empty. Nothing tells the operator why — that is
    // the model: the filter is the author's, not theirs.
    expect(
      names({ instanceFilter: 'worker', instanceAttributes: [{ attribute: 'language', op: 'eq', value: 'java' }] }),
    ).toEqual([]);
  });
});


/**
 * What a page filter must NOT touch.
 *
 * The service half guarantees a page never changes which entity is
 * selected. The instance half has to match: the shared selection is the
 * operator's, sticky across every tab of the layer, and a page that
 * rewrote it would change what they are reading everywhere else —
 * permanently, with no undo, and blaming the service for an exclusion
 * the page made.
 */
describe('a page that excludes the selected instance', () => {
  it('leaves it out of the page list, which is the whole mechanism', () => {
    const m = instancePageMatcher({ instanceFilter: 'broker' });
    expect(LIST.filter(m).some((i) => i.name === 'worker-1')).toBe(false);
  });

  it('still has something for the page to show', () => {
    // The page falls back to its OWN first row rather than to nothing —
    // an empty widget batch on a page that has instances would read as
    // broken data.
    const shown = LIST.filter(instancePageMatcher({ instanceFilter: 'broker' }));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown[0]!.name).toBe('broker-1');
  });
});
