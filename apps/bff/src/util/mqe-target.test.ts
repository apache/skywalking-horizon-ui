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
 * Where the Inspect page sends an MQE expression.
 *
 * Normally: nowhere new. `execExpression` is a query-protocol query on the
 * same `/graphql` as everything else, so with no override the configured
 * `oap.queryUrl` IS the MQE surface — scheme, host, port and basic auth all
 * already line up. There is no version story here; MQE has been part of the
 * query protocol throughout.
 *
 * The config dump is read only for a PARTIAL override, where an operator gave
 * a host or a port but not both. That path reads OAP's own keys, so the key
 * NAMES are the contract — and they were read as `sharing-server.default.*`
 * when the module is `receiver-sharing-server`, so the lookup matched nothing
 * in any dump. The dumps below are the shape a live OAP returns (verified
 * against the public demo): every port is a string, and a listener that is off
 * is `0`.
 */

import { describe, it, expect } from 'vitest';
import { MqeTargetCache } from './mqe-target.js';
import { configSchema } from '../config/schema.js';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';

const ADMIN = 'http://oap.test:17128';
const QUERY = 'https://oap.test:12800';

function targetFor(dump: Record<string, string>, mqe?: { host?: string; port?: number }) {
  const fetch: FetchLike = async () =>
    new Response(JSON.stringify(dump), { status: 200, headers: { 'content-type': 'application/json' } });
  const config = configSchema.parse({
    oap: { queryUrl: QUERY, adminUrl: ADMIN, ...(mqe ? { mqe } : {}) },
  });
  return new MqeTargetCache().resolve({ config: () => config, fetch });
}

/** What OAP ships: the query GraphQL on core, the sharing server off. */
const DEFAULT_DUMP = {
  'core.default.restHost': '0.0.0.0',
  'core.default.restPort': '12800',
  'receiver-sharing-server.default.restHost': '0.0.0.0',
  'receiver-sharing-server.default.restPort': '0',
};

describe('mqe target', () => {
  it('sends to the configured query endpoint, scheme and all', async () => {
    const t = await targetFor(DEFAULT_DUMP);
    // Not rediscovered: rebuilding it from the dump would drop the https and
    // hand back a wildcard bind host.
    expect(t.baseUrl).toBe(QUERY);
    expect(t.via).toBe('oap.queryUrl');
  });

  it('discovers the half an operator did not give', async () => {
    const t = await targetFor(DEFAULT_DUMP, { host: 'mqe.internal' });
    expect(t.baseUrl).toBe('http://mqe.internal:12800');
    expect(t.via).toContain('core');
  });

  it('follows the sharing server when an operator has turned it on', async () => {
    // The key is `receiver-sharing-server`; read as `sharing-server` it
    // matched nothing and this preference never applied.
    const t = await targetFor(
      { ...DEFAULT_DUMP, 'receiver-sharing-server.default.restPort': '12801' },
      { host: 'mqe.internal' },
    );
    expect(t.baseUrl).toBe('http://mqe.internal:12801');
    expect(t.via).toContain('receiver-sharing-server');
  });

  it('ignores a sharing server that is present but not listening', async () => {
    // `0` is how OAP spells "disabled"; reading it as a port would send every
    // expression somewhere nothing answers.
    const t = await targetFor(DEFAULT_DUMP, { host: 'mqe.internal' });
    expect(t.baseUrl).toBe('http://mqe.internal:12800');
  });

  it('reaches a wildcard bind through the admin URL host', async () => {
    const t = await targetFor(DEFAULT_DUMP, { port: 12800 });
    expect(t.baseUrl).toBe('http://oap.test:12800');
  });

  it('takes a full override without asking OAP anything', async () => {
    const t = await targetFor(DEFAULT_DUMP, { host: 'mqe.internal', port: 9999 });
    expect(t.baseUrl).toBe('http://mqe.internal:9999');
    expect(t.via).toContain('override');
  });
});
