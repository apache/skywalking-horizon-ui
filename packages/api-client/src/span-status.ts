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
 * Reading a span's outcome off the attributes it carries.
 *
 * Every trace surface that does not get a status from the backend asks this:
 * a Zipkin span has no status field at all, an OTLP span converted from one
 * arrives `unset`, and a Tempo search result carries no status either. The
 * only evidence any of them holds is whichever marker the instrumentation
 * wrote, so the table covers SkyWalking's, Zipkin's and OpenTelemetry's
 * conventions, and ONE table answers for all of them — three pages inferring
 * the same thing by three different rules disagreed about the same span.
 *
 * Which markers a TraceQL SEARCH result carries is an OAP setting
 * (`SW_TRACEQL_*_TRACES_LIST_RESULT_TAGS`), so a list may hold none at all.
 *
 * WHAT AN EMPTY VALUE MEANS IS THE SOURCE'S BUSINESS, not the table's, and the
 * two sources disagree — see `emptyIsAbsent`.
 */

/** A verdict, or `null` for no verdict. Absence of evidence is never success:
 *  a span that says nothing leaves the trace UNKNOWN rather than healthy. */
export type SpanOutcome = 'error' | 'ok' | null;

/** One attribute, and what its value says. */
interface ErrorTagRule {
  key: string;
  /** Absent means presence alone is the failure (Zipkin/OTel error markers). */
  read?: (value: string) => SpanOutcome;
}

/** A status code that does not parse as a number is not a status code — and
 *  an empty one is not either, though `Number('')` is a perfectly good 0. */
const httpOutcome = (v: string): SpanOutcome => {
  if (!v.trim()) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n >= 400 ? 'error' : 'ok';
};

/** RPC status codes are gRPC-style: 0 / OK is success, anything else is not.
 *  A non-numeric, non-OK value is a named code (`UNAVAILABLE`), so it fails. */
const rpcOutcome = (v: string): SpanOutcome => {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  if (Number.isFinite(n)) return n === 0 ? 'ok' : 'error';
  return t.toUpperCase() === 'OK' ? 'ok' : 'error';
};

/** OTLP's own three states, by name or by enum ordinal. UNSET is the third
 *  one — and it is the absence of a verdict, not a success. */
const otelOutcome = (v: string): SpanOutcome => {
  const t = v.trim().toUpperCase();
  if (t === 'ERROR' || t === 'STATUS_CODE_ERROR' || t === '2') return 'error';
  if (t === 'OK' || t === 'STATUS_CODE_OK' || t === '1') return 'ok';
  return null;
};

/** A marker whose VALUE can still say "not a failure" — Zipkin writes the
 *  message there, but an instrumentation may write a boolean.
 *
 *  An EMPTY one is still a failure, because in Zipkin the tag's presence is
 *  the signal and its value is only the message: `DependencyLinker` reads
 *  `tags().containsKey("error")`, and the protobuf writer goes out of its way
 *  to keep `error -> ""` on the wire rather than dropping it. A span that
 *  never carried the tag does not reach here — the source decides that. */
const markerOutcome = (v: string): SpanOutcome => {
  const t = v.trim().toLowerCase();
  return t === 'false' || t === '0' ? 'ok' : 'error';
};

export const TRACE_ERROR_TAGS: readonly ErrorTagRule[] = [
  { key: 'error', read: markerOutcome },
  { key: 'http.status_code', read: httpOutcome },
  { key: 'http.response.status_code', read: httpOutcome },
  { key: 'rpc.status_code', read: rpcOutcome },
  { key: 'grpc.status_code', read: rpcOutcome },
  { key: 'rpc.grpc.status_code', read: rpcOutcome },
  { key: 'otel.status_code', read: otelOutcome },
  { key: 'status.code', read: otelOutcome },
  { key: 'exception.type' },
  { key: 'error.kind' },
  { key: 'error.type' },
  { key: 'error.message' },
  { key: 'error.object' },
];

/**
 * What these attributes say about an outcome.
 *
 * `emptyIsAbsent` says how THIS source spells "the span did not carry it",
 * which is the one thing the table cannot know:
 *
 *  - A **TraceQL search** response pads it. OAP writes every projected key on
 *    every span in a span set, missing ones as `""`, so that the set has one
 *    shape (its converter says so: a Grafana DataFrame panics otherwise).
 *    There an empty value is a tag the span never had — pass `true`.
 *  - **Zipkin tags** and a TraceQL **trace-by-id** omit what was not set, so
 *    an empty value is a value the span chose to write. `error: ""` is the
 *    canonical one, and it means the span failed.
 *
 * Reading a padded `""` as a verdict reddens a whole trace over a tag nobody
 * wrote; reading a real empty `error` as nothing hides a failure Zipkin
 * deliberately preserves. Hence the parameter rather than one rule for both.
 */
export function attributesReportOutcome(
  attrs: ReadonlyArray<{ key: string; value: string }>,
  { emptyIsAbsent = false }: { emptyIsAbsent?: boolean } = {},
): SpanOutcome {
  let ok = false;
  for (const a of attrs) {
    const rule = TRACE_ERROR_TAGS.find((r) => r.key === a.key);
    if (!rule) continue;
    if (emptyIsAbsent && a.value.trim() === '') continue;
    const said = rule.read ? rule.read(a.value) : 'error';
    if (said === 'error') return 'error';
    if (said === 'ok') ok = true;
  }
  return ok ? 'ok' : null;
}

/** Whether these attributes report a failure — what a row asks when it has
 *  attributes and no status of any kind. */
export function attributesReportError(
  attrs: ReadonlyArray<{ key: string; value: string }>,
  opts?: { emptyIsAbsent?: boolean },
): boolean {
  return attributesReportOutcome(attrs, opts) === 'error';
}

/** The same question for Zipkin, whose tags are a map rather than a list.
 *  Zipkin has no status field at all, so its pages have always inferred one;
 *  this is that inference, sharing the table with everything else. */
export function tagsReportError(tags: Readonly<Record<string, string>> | null | undefined): boolean {
  if (!tags) return false;
  return attributesReportError(Object.entries(tags).map(([key, value]) => ({ key, value })));
}

/** One span's outcome. The OTLP status is the span's own word and wins; an
 *  `unset` status falls through to the markers, which is the only evidence a
 *  converted Zipkin span ever carries. */
export function spanOutcome(span: {
  status: 'ok' | 'error' | 'unset';
  attributes: ReadonlyArray<{ key: string; value: string }>;
}): SpanOutcome {
  if (span.status !== 'unset') return span.status;
  return attributesReportOutcome(span.attributes);
}

/** A trace's outcome, folded from its spans. ONE failing span fails the trace;
 *  calling it a success needs a span that says so and none that disagree. */
export function traceOutcome(
  spans: ReadonlyArray<{
    status: 'ok' | 'error' | 'unset';
    attributes: ReadonlyArray<{ key: string; value: string }>;
  }>,
): SpanOutcome {
  let ok = false;
  for (const s of spans) {
    const own = spanOutcome(s);
    if (own === 'error') return 'error';
    if (own === 'ok') ok = true;
  }
  return ok ? 'ok' : null;
}
