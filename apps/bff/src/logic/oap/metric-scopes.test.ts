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

import { beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { _resetMetricScopes, relationOnlyExpressions } from './metric-scopes.js';

const CATALOG = [
  { name: 'service_relation_server_cpm', catalog: 'SERVICE_RELATION' },
  { name: 'service_relation_server_resp_time', catalog: 'SERVICE_RELATION' },
  { name: 'service_cpm', catalog: 'SERVICE' },
];
const opts = (down = false) => {
  const fetch: FetchLike = async () => {
    if (down) throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify({ data: { metrics: CATALOG } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { queryUrl: 'http://oap:12800', timeoutMs: 5000, fetch };
};

beforeEach(() => _resetMetricScopes());

describe('which edge expressions read relation metrics only', () => {
  it('takes an expression every metric of which is a relation metric', async () => {
    const e = [
      'service_relation_server_cpm',
      'avg(service_relation_server_resp_time{p="service_cpm"})',
      'service_relation_server_cpm / service_cpm',
      'top_n(service_relation_server_cpm, 5, des)',
      'baseline(service_relation_server_cpm, value)',
      'no_such_metric',
    ];
    expect([...((await relationOnlyExpressions(opts(), e)) ?? [])]).toEqual([
      'service_relation_server_cpm',
      'avg(service_relation_server_resp_time{p="service_cpm"})',
    ]);
  });

  it('says so when OAP\'s catalog cannot be read, rather than answering none', async () => {
    expect(await relationOnlyExpressions(opts(true), ['service_relation_server_cpm'])).toBeNull();
  });
});
