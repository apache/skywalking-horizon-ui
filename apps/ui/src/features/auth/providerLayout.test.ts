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
import type { SsoProvider } from '@/api/client';
import { SSO_BUTTON_MAX, splitProviders } from './providerLayout';

const of = (...ids: string[]): SsoProvider[] =>
  ids.map((id) => ({ id, displayName: id, icon: '' }));

describe('an SSO-only card lists providers as buttons', () => {
  const SSO_ONLY = false; // no password form on the card

  it('gives every provider a button while there are four or fewer', () => {
    for (let n = 1; n <= SSO_BUTTON_MAX; n++) {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      const { listed, overflow } = splitProviders(of(...ids), SSO_ONLY);
      expect(listed.map((p) => p.id)).toEqual(ids);
      expect(overflow).toEqual([]);
    }
  });

  /**
   * The fifth does NOT replace the list with a picker. The first four keep
   * their buttons and only the remainder folds away, so adding a fifth
   * provider never changes how the first four are reached.
   */
  it('keeps the first four as buttons and folds only the rest away', () => {
    const { listed, overflow } = splitProviders(of('a', 'b', 'c', 'd', 'e', 'f', 'g'), SSO_ONLY);
    expect(listed.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(overflow.map((p) => p.id)).toEqual(['e', 'f', 'g']);
  });

  it('has nothing to show when no provider is configured', () => {
    expect(splitProviders([], SSO_ONLY)).toEqual({ listed: [], overflow: [] });
  });
});

describe('a card that also takes a password folds every provider away', () => {
  /**
   * The password half has already spent the card's height on two fields and a
   * Sign-in button. Provider buttons under that push the last of them off a
   * laptop screen, so beside a password form the picker is the whole SSO
   * affordance — however few providers there are.
   */
  it.each([1, 2, 4, 5, 9])('folds all %i of them into the picker', (n) => {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const { listed, overflow } = splitProviders(of(...ids), true);
    expect(listed).toEqual([]);
    expect(overflow.map((p) => p.id)).toEqual(ids);
  });

  // The four-button layout is the SSO-only card's, and nothing else's.
  it('never buttons a provider just because there are few of them', () => {
    expect(splitProviders(of('only-one'), true).listed).toEqual([]);
    expect(splitProviders(of('only-one'), false).listed).toHaveLength(1);
  });

  it('still shows nothing when no provider is configured', () => {
    expect(splitProviders([], true)).toEqual({ listed: [], overflow: [] });
  });
});

describe('the order is the configuration’s', () => {
  /**
   * Nothing sorts, and that is load-bearing rather than incidental: on an
   * SSO-only card with five or more providers, config order is what decides
   * which four are reachable without opening the picker.
   */
  it('preserves config order rather than sorting by name', () => {
    const { listed } = splitProviders(of('okta', 'entra', 'github', 'auth0'), false);
    expect(listed.map((p) => p.id)).toEqual(['okta', 'entra', 'github', 'auth0']);
  });

  it('lets config order decide which providers get a button', () => {
    const first = splitProviders(of('github', 'okta', 'entra', 'auth0', 'keycloak'), false);
    const swapped = splitProviders(of('keycloak', 'okta', 'entra', 'auth0', 'github'), false);
    expect(first.listed.map((p) => p.id)).toContain('github');
    expect(first.overflow.map((p) => p.id)).toEqual(['keycloak']);
    expect(swapped.listed.map((p) => p.id)).toContain('keycloak');
    expect(swapped.overflow.map((p) => p.id)).toEqual(['github']);
  });

  it('keeps that order inside the picker too', () => {
    const { overflow } = splitProviders(of('okta', 'entra', 'github'), true);
    expect(overflow.map((p) => p.id)).toEqual(['okta', 'entra', 'github']);
  });
});
