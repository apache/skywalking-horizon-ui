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
 * The access log must not become a second copy of who was looked up.
 *
 * The audit page filters by person, and the docs tell operators to run at
 * `LOG_LEVEL=info` for access logs — which carried the whole URL, query string
 * included. That put audit subjects into a store with its own retention,
 * outside the audit log's rules and readable by anyone who can read logs.
 */

import { describe, expect, it } from 'vitest';
import { loggerOptions } from './logger.js';

const req = loggerOptions.serializers?.req as (r: unknown) => { url: string };

describe('access-logged request URLs', () => {
  it('keeps the path and drops the arguments', () => {
    expect(req({ method: 'GET', url: '/api/admin/audit?username=alice%40corp.example&kind=sso' }).url)
      .toBe('/api/admin/audit?[redacted]');
  });

  it('leaves a URL with no query string alone', () => {
    expect(req({ method: 'GET', url: '/api/admin/audit/status' }).url).toBe('/api/admin/audit/status');
  });

  it('carries no identity for any filter the page can send', () => {
    const line = JSON.stringify(req({
      method: 'GET',
      url: '/api/admin/audit?from=1&to=2&kind=sso&username=alice%40corp.example',
      ip: '203.0.113.7',
    }));
    expect(line).not.toContain('alice');
    expect(line).not.toContain('corp.example');
    // The address stays: it is what an access log is for.
    expect(line).toContain('203.0.113.7');
  });
});
