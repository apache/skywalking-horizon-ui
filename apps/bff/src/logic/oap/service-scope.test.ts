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
import { serviceNormalOf, serviceScopeOf } from './service-scope.js';

const SERVICE_ID = 'bWVzaC1zdnI6OnNvbmdz.1';
const SERVICE_NAME = 'songs.sample-services';

describe('serviceScopeOf — the identity travels, nothing is resolved', () => {
  it('reads the pair the roster returned', () => {
    expect(serviceScopeOf({ serviceId: SERVICE_ID, service: SERVICE_NAME })).toEqual({
      kind: 'service',
      service: { id: SERVICE_ID, name: SERVICE_NAME },
    });
  });

  it('trims both halves', () => {
    expect(serviceScopeOf({ serviceId: ` ${SERVICE_ID} `, service: `  ${SERVICE_NAME} ` })).toEqual({
      kind: 'service',
      service: { id: SERVICE_ID, name: SERVICE_NAME },
    });
  });

  it('reports "all" only when neither half was sent', () => {
    expect(serviceScopeOf({})).toEqual({ kind: 'all' });
    expect(serviceScopeOf({ serviceId: '', service: '' })).toEqual({ kind: 'all' });
    expect(serviceScopeOf({ serviceId: null, service: null })).toEqual({ kind: 'all' });
  });

  // The deleted lookup lived exactly here: a bare name used to be matched
  // against `listServices(layer)`. With nothing to match it against, refusing is
  // the only honest answer — "all services" would answer under this name.
  it('refuses a NAME that arrived without its id', () => {
    const scope = serviceScopeOf({ service: SERVICE_NAME });
    expect(scope.kind).toBe('incomplete');
    expect(scope.kind === 'incomplete' && scope.message).toContain(SERVICE_NAME);
    expect(scope.kind === 'incomplete' && scope.message).toContain('serviceId');
  });

  // An OAP id addresses exactly one entity, so a caller that holds only one —
  // the Explore entity form builds it from the operator's own name + isReal —
  // still queries. The name-keyed routes check for the name themselves.
  it('scopes on an id that came without a name', () => {
    expect(serviceScopeOf({ serviceId: SERVICE_ID })).toEqual({
      kind: 'service',
      service: { id: SERVICE_ID, name: '' },
    });
  });

  // An id is `base64(<name>).<0|1>`, a shape an ordinary name can wear
  // (`api.1`), and a name can equally be some other service's id string. Neither
  // half is ever inspected or matched — each is used where OAP asks for it.
  it('never trades one half for the other, however they are shaped', () => {
    expect(serviceScopeOf({ serviceId: 'api.1', service: 'gateway' })).toEqual({
      kind: 'service',
      service: { id: 'api.1', name: 'gateway' },
    });
  });
});

describe('serviceNormalOf', () => {
  it('reads the flag only when it is literally true/false', () => {
    expect(serviceNormalOf('true')).toBe(true);
    expect(serviceNormalOf('false')).toBe(false);
    for (const junk of ['', '1', '0', 'yes', 'TRUE', undefined, null]) {
      expect(serviceNormalOf(junk)).toBeNull();
    }
  });
});
