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
 * Over-fetch-by-one paging. The one place that answers "is there another
 * page?" for every capped or paged list read in the BFF.
 *
 * No OAP list query returns a total or a has-more flag, and `Pagination` is
 * exactly `{ pageNum, pageSize }` — there is no count to opt into. So the
 * answer has to be READ, and reading it takes two shapes because OAP derives
 * the offset from the page size (`PaginationUtils.exchange`: `limit = pageSize`,
 * `from = pageSize * (pageNum - 1)`):
 *
 *   - page 1, and every capped read that has no pager at all: ask for
 *     `pageSize + 1`. `from` is 0 for ANY page size, so the extra row is
 *     exactly the first row of page 2.
 *   - page N >= 2: `pageSize + 1` would move `from` to `(N-1)*(S+1)` and skip
 *     `N-1` rows, so the page is asked at its true size and a separate one-row
 *     PROBE at `{ pageNum: N*S + 1, pageSize: 1 }` reads offset `N*S` — the
 *     first row of page N+1.
 *
 * `hasNext` is the only paging fact this can honestly report: there IS more,
 * never how much more. Callers must not turn it back into a total.
 */

import { graphqlPost, type GraphqlOptions } from '../../client/graphql.js';

/** OAP's `Pagination` input, verbatim. */
export interface OapPaging {
  pageNum: number;
  pageSize: number;
}

export interface PageResult<Row> {
  rows: Row[];
  /** 1-based page these rows came from. */
  pageNum: number;
  /** Rows per page as DISPLAYED — never the over-fetch size. */
  pageSize: number;
  hasNext: boolean;
}

/**
 * Rows to SKIP for a 1-based page — `pageSize * (pageNum - 1)`.
 *
 * OAP's own formula (`PaginationUtils.exchange`), so a store Horizon owns and
 * a query OAP answers page identically. `pageNum` below 1 is treated as 1,
 * matching OAP, rather than producing a negative offset that reaches a
 * backend.
 */
export function pageOffset(pageNum: number, pageSize: number): number {
  return Math.max(0, (Math.max(1, Math.trunc(pageNum)) - 1) * pageSize);
}

/** Rows to ask a backend for when `size` are to be rendered. The +1 is a
 *  fetch-side detail and is allowed to exceed a display cap by exactly one —
 *  clamping it back would lose the signal at the top of the range, which is
 *  the only range where it matters. */
export function overFetchSize(size: number): number {
  return size + 1;
}

/** Split an over-fetched array into the display page plus the has-more flag.
 *  For row-order-sensitive feeds this must run BEFORE any re-sort: the extra
 *  row is a page boundary in the backend's order, not a member of the page. */
export function takeOverFetched<Row>(
  fetched: readonly Row[],
  size: number,
): { rows: Row[]; hasNext: boolean } {
  const hasNext = fetched.length > size;
  return { rows: fetched.slice(0, size), hasNext };
}

/** Paging that reads the first row of the page AFTER `pageNum`. Only valid for
 *  `pageNum >= 2`; page 1 uses the over-fetch instead. */
export function probePaging(pageNum: number, pageSize: number): OapPaging {
  return { pageNum: pageNum * pageSize + 1, pageSize: 1 };
}

function sanePage(page: OapPaging): OapPaging {
  return {
    pageNum: Math.max(1, Math.round(page.pageNum)),
    pageSize: Math.max(1, Math.round(page.pageSize)),
  };
}

/**
 * Read one page through a caller-supplied fetcher — for backends whose query
 * is not condition-shaped (OAP root args, a REST limit). One backend call on
 * page 1; two on page N >= 2. Prefer {@link readPage} when both can ride a
 * single GraphQL document.
 */
export async function readPageWith<Row>(
  fetchRows: (paging: OapPaging) => Promise<readonly Row[]>,
  page: OapPaging,
): Promise<PageResult<Row>> {
  const { pageNum, pageSize } = sanePage(page);
  if (pageNum === 1) {
    const fetched = await fetchRows({ pageNum: 1, pageSize: overFetchSize(pageSize) });
    return { ...takeOverFetched(fetched, pageSize), pageNum, pageSize };
  }
  const [rows, probe] = await Promise.all([
    fetchRows({ pageNum, pageSize }),
    fetchRows(probePaging(pageNum, pageSize)),
  ]);
  return { rows: [...rows], pageNum, pageSize, hasNext: probe.length > 0 };
}

/** A condition-shaped OAP list query — one root field taking one input object
 *  that carries `paging`. Every field here is static GraphQL text; nothing
 *  about the caller's domain leaks into this module. */
export interface PagedQuerySpec {
  operationName: string;
  /** GraphQL type of the condition variable, e.g. `LogQueryCondition`. */
  conditionType: string;
  /** OAP root field, e.g. `queryLogs`. */
  field: string;
  /** Argument the root field takes the condition on. */
  argName?: string;
  /** Field on the root result holding the rows, e.g. `logs`. */
  rowsField: string;
  /** Selection set for one rendered row. */
  rowsSelection: string;
  /** Cheapest selection that proves a row exists — the probe never renders. */
  probeSelection: string;
}

function pageDocument(spec: PagedQuerySpec, withProbe: boolean): string {
  const arg = spec.argName ?? 'condition';
  const vars = withProbe
    ? `($condition: ${spec.conditionType}, $probe: ${spec.conditionType})`
    : `($condition: ${spec.conditionType})`;
  const probeField = withProbe
    ? `\n  probe: ${spec.field}(${arg}: $probe) { ${spec.rowsField} { ${spec.probeSelection} } }`
    : '';
  return `query ${spec.operationName}${vars} {
  data: ${spec.field}(${arg}: $condition) { ${spec.rowsField} { ${spec.rowsSelection} } }${probeField}
}`;
}

/**
 * Read one page of a condition-shaped OAP list query. Page 1 is a single
 * over-fetched call; page N >= 2 is ONE document carrying the page and its
 * probe as two aliased root fields, so both read the same window — the
 * condition builder is invoked twice with the same closed-over time range, and
 * no `now()` can drift between them.
 */
export async function readPage<Row>(
  opts: GraphqlOptions,
  spec: PagedQuerySpec,
  condition: (paging: OapPaging) => Record<string, unknown>,
  page: OapPaging,
): Promise<PageResult<Row>> {
  const { pageNum, pageSize } = sanePage(page);
  if (pageNum === 1) {
    const env = await graphqlPost<{ data: Record<string, Row[] | null> | null }>(
      opts,
      pageDocument(spec, false),
      { condition: condition({ pageNum: 1, pageSize: overFetchSize(pageSize) }) },
    );
    const fetched = env.data?.[spec.rowsField] ?? [];
    return { ...takeOverFetched(fetched, pageSize), pageNum, pageSize };
  }
  const env = await graphqlPost<{
    data: Record<string, Row[] | null> | null;
    probe: Record<string, unknown[] | null> | null;
  }>(opts, pageDocument(spec, true), {
    condition: condition({ pageNum, pageSize }),
    probe: condition(probePaging(pageNum, pageSize)),
  });
  return {
    rows: [...(env.data?.[spec.rowsField] ?? [])],
    pageNum,
    pageSize,
    hasNext: (env.probe?.[spec.rowsField] ?? []).length > 0,
  };
}
