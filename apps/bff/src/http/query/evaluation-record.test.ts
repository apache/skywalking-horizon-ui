/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to you under the Apache License, Version 2.0
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

import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { fetchEvaluationRecords } from './evaluation-record.js';

interface Paging { pageNum: number; pageSize: number }

function slice<T>(rows: readonly T[], paging: Paging): T[] {
  const from = paging.pageSize * (paging.pageNum - 1);
  return rows.slice(from, from + paging.pageSize);
}

describe('evaluation-record paging', () => {
  it('keeps page 2 at the requested size and probes page 3 without skipping a row', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      traceRef: { type: 'SKYWALKING_NATIVE', traceId: `trace-${i}` },
      valueType: 'SCORE',
      scoreValue: i,
      evaluationTime: i,
    }));
    let variables: Record<string, { paging: Paging }> = {};
    const fetch: FetchLike = async (_url, init) => {
      const request = JSON.parse(String(init?.body ?? '{}')) as {
        variables: Record<string, { paging: Paging }>;
      };
      variables = request.variables;
      return new Response(JSON.stringify({
        data: {
          data: { genAIEvaluationRecordList: slice(rows, variables.condition.paging) },
          probe: { genAIEvaluationRecordList: slice(rows, variables.probe.paging) },
        },
      }), { headers: { 'content-type': 'application/json' } });
    };

    const result = await fetchEvaluationRecords(
      { queryUrl: 'http://oap.invalid', timeoutMs: 1_000, fetch },
      {},
      { start: '2026-01-01 000000', end: '2026-01-01 010000' },
      { pageNum: 2, pageSize: 50 },
      false,
    );

    expect(variables.condition.paging).toEqual({ pageNum: 2, pageSize: 50 });
    expect(variables.probe.paging).toEqual({ pageNum: 101, pageSize: 1 });
    expect(result.records[0]?.traceId).toBe('trace-50');
    expect(result.records.at(-1)?.traceId).toBe('trace-99');
    expect(result.hasNext).toBe(true);
  });
});
