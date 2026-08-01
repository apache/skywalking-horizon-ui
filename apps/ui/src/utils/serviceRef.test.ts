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
 * The service-identity contract: a query carries the roster row WHOLE. OAP
 * folds the normal/virtual flag into the id (`base64(name).<1|0>`), so half an
 * identity cannot produce the other half — it can only produce a guess that
 * addresses a different entity.
 */

import { describe, expect, it } from 'vitest';
import { serviceRef, serviceRefFields } from './serviceRef';

const ID = 'bWVzaC1zdnI6OnNvbmdz.1';
const NAME = 'songs';

describe('serviceRef', () => {
  it('keeps both halves together', () => {
    expect(serviceRef(ID, NAME)).toEqual({ id: ID, name: NAME, normal: null });
  });

  // The flag rides along from the SAME roster row for the OAP calls that key on
  // the name; it is never a third thing the caller decides on its own.
  it('carries the roster row\'s normal flag when it has one', () => {
    expect(serviceRef(ID, NAME, false)).toEqual({ id: ID, name: NAME, normal: false });
  });

  it('is null when either half is missing — never a partial identity', () => {
    expect(serviceRef(ID, '')).toBeNull();
    expect(serviceRef('', NAME)).toBeNull();
    expect(serviceRef(null, NAME)).toBeNull();
    expect(serviceRef(ID, undefined)).toBeNull();
    expect(serviceRef(null, null)).toBeNull();
  });
});

describe('serviceRefFields', () => {
  // Both slots are filled on every request: the BFF uses whichever half the
  // upstream OAP API takes, and looks up neither.
  it('sends the id AND the name', () => {
    expect(serviceRefFields(serviceRef(ID, NAME))).toEqual({ serviceId: ID, service: NAME });
  });

  it('sends the normal flag whenever the identity carries one', () => {
    expect(serviceRefFields(serviceRef(ID, NAME, false))).toEqual({
      serviceId: ID,
      service: NAME,
      normal: 'false',
    });
    expect(serviceRefFields(serviceRef(ID, NAME, true))?.normal).toBe('true');
  });

  it('sends nothing at all when there is no service', () => {
    expect(serviceRefFields(null)).toEqual({});
  });
});
