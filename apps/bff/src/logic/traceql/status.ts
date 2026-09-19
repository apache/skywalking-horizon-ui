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
 * Whether each trace in a search result FAILED.
 *
 * The Tempo search response cannot say: its spans carry only the tags OAP
 * chose to project — on the native datasource `service.name`, `span.kind` and
 * the span's own tags — and a SkyWalking span's failure is a field, not a tag.
 * An errored trace and a healthy one come back indistinguishable, which left
 * every row unknown until the operator opened it.
 *
 * What the backend DOES apply is the `status` condition: on the native
 * datasource it becomes `TraceState.ERROR`, on the Zipkin one an `error`
 * annotation query, both trace-level. So the same search is run a second time
 * with that condition, and the ids it returns are the failures.
 *
 * It answers ONE way only: a trace in that result failed. Absence proves
 * nothing, for two reasons — the page may be truncated, and OAP matches these
 * conditions per SEGMENT rather than over the whole trace. Measured on the
 * demo: `{resource.service.name="agent::frontend"}` returns 20 traces and the
 * same query with `status="error"` returns none, while six of those traces
 * carry errored spans in the services downstream. Inferring success from a
 * miss would therefore paint failed traces green, which is the one thing this
 * must never do; success is established by reading the trace instead.
 */

import type { TraceQLTraceRow } from '@skywalking-horizon-ui/api-client';
import { traceqlSearch, type TraceQLClientOpts } from '../../client/traceql.js';

/** A `status` the expression already constrains, read outside string literals
 *  so a value like `span.message="status=error"` is not mistaken for one. */
export function statusTermIn(q: string | undefined): 'ok' | 'error' | 'other' | null {
  if (!q) return null;
  // The BARE intrinsic only: `span.business_status="ok"` is an application
  // tag, and reading it as the trace's status would skip the verification and
  // call every row a success.
  const re = /(?:^|[\s{(&|])status\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    if (insideLiteral(q, m.index)) continue;
    const v = m[1]!.replace(/\\(["\\])/g, '$1').toLowerCase();
    return v === 'ok' || v === 'error' ? v : 'other';
  }
  return null;
}

function insideLiteral(q: string, at: number): boolean {
  let inLit = false;
  for (let i = 0; i < at; i++) {
    const c = q[i];
    if (inLit) {
      if (c === '\\') i++;
      else if (c === '"') inLit = false;
    } else if (c === '"') {
      inLit = true;
    }
  }
  return inLit;
}

/** The same query, restricted to failed traces, or null when the expression is
 *  not the single spanset the editor allows and cannot be extended safely. */
export function withStatusError(q: string | undefined): string | null {
  const t = (q ?? '').trim();
  if (!t) return '{status="error"}';
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  const inner = t.slice(1, -1).trim();
  return inner ? `{${inner} && status="error"}` : '{status="error"}';
}

export interface StatusPassParams {
  q?: string;
  startMs: number;
  endMs: number;
  limit: number;
}

/**
 * Fill in each row's `isError`, leaving it undefined where the answer is not
 * known. Never throws: a failed second search costs the statuses, not the list.
 */
/** Whether the expression branches, so no single condition in it is implied
 *  by a row being in the result. Literals are blanked first — a service named
 *  `a||b` is not an alternation. */
function alternates(q: string | undefined): boolean {
  return /\|\||\bor\b/i.test((q ?? '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' '));
}

export async function fillTraceStatuses(
  opts: TraceQLClientOpts,
  params: StatusPassParams,
  rows: TraceQLTraceRow[],
): Promise<TraceQLTraceRow[]> {
  if (rows.length === 0 || rows.every((r) => r.isError !== undefined)) return rows;

  // A term inside an alternation does not hold for every row the query
  // matched: `{status="error" || status="ok"}` selects both, and reading the
  // first term as a promise paints the healthy half red.
  const term = alternates(params.q) ? null : statusTermIn(params.q);
  // The operator asked for failures and the backend answered: every row here
  // contains one. The mirror of this does NOT hold — `status="ok"` selects
  // traces whose matching segment succeeded, which says nothing about the rest
  // of the trace — so it establishes nothing and is left to the reader.
  if (term === 'error') return rows.map((r) => ({ ...r, isError: true }));
  if (term === 'ok') return rows;

  const q = withStatusError(params.q);
  if (q === null) return rows;

  let errors: TraceQLTraceRow[];
  try {
    errors = await traceqlSearch(opts, { q, startMs: params.startMs, endMs: params.endMs, limit: params.limit });
  } catch {
    return rows;
  }

  const failed = new Set(errors.map((e) => e.traceId));
  // Only the positive half is applied. A row this search did not return keeps
  // its unknown status and is settled by reading the trace.
  return rows.map((r) => (r.isError === undefined && failed.has(r.traceId) ? { ...r, isError: true } : r));
}
