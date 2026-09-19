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
 * The attributes that say a span FAILED.
 *
 * A Tempo search result carries no span status, and which attributes it does
 * carry is an OAP setting (`SW_TRACEQL_*_TRACES_LIST_RESULT_TAGS`), so the
 * only failure evidence a list can hold is whichever marker the deployment
 * happens to project — hence a list covering SkyWalking's, Zipkin's and
 * OpenTelemetry's conventions.
 *
 * They declare failure ONLY. A 200 on one span says nothing about a sibling
 * that threw without tagging anything, so `false` here means "no marker
 * reports a failure", never "the trace succeeded".
 */

/** One attribute, and what its value has to look like to mean a failure. */
interface ErrorTagRule {
  key: string;
  /** Absent means presence alone is the failure (Zipkin/OTel error markers). */
  failsWhen?: (value: string) => boolean;
}

const httpFails = (v: string): boolean => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 400;
};

/** RPC status codes are gRPC-style: 0 / OK is success, anything else is not.
 *  A non-numeric, non-OK value is a named code (`UNAVAILABLE`), so it fails. */
const rpcFails = (v: string): boolean => {
  const t = v.trim();
  if (!t) return false;
  const n = Number(t);
  if (Number.isFinite(n)) return n !== 0;
  return t.toUpperCase() !== 'OK';
};

const otelStatusFails = (v: string): boolean => {
  const t = v.trim().toUpperCase();
  return t === 'ERROR' || t === 'STATUS_CODE_ERROR' || t === '2';
};

/** A marker whose VALUE can still say "not a failure" — Zipkin writes the
 *  message there, but an instrumentation may write a boolean. Empty says
 *  nothing at all: OAP pads spans that lack a projected attribute with `""`,
 *  so treating that as a failure would redden a whole trace for the spans
 *  that never carried the tag. */
const markerFails = (v: string): boolean => {
  const t = v.trim().toLowerCase();
  return t !== '' && t !== 'false' && t !== '0';
};

export const TRACE_ERROR_TAGS: readonly ErrorTagRule[] = [
  { key: 'error', failsWhen: markerFails },
  { key: 'http.status_code', failsWhen: httpFails },
  { key: 'http.response.status_code', failsWhen: httpFails },
  { key: 'rpc.status_code', failsWhen: rpcFails },
  { key: 'grpc.status_code', failsWhen: rpcFails },
  { key: 'rpc.grpc.status_code', failsWhen: rpcFails },
  { key: 'otel.status_code', failsWhen: otelStatusFails },
  { key: 'status.code', failsWhen: otelStatusFails },
  { key: 'exception.type' },
  { key: 'error.kind' },
  { key: 'error.type' },
  { key: 'error.message' },
  { key: 'error.object' },
];

/** Whether these attributes report a failure. */
export function attributesReportError(attrs: ReadonlyArray<{ key: string; value: string }>): boolean {
  for (const a of attrs) {
    const rule = TRACE_ERROR_TAGS.find((r) => r.key === a.key);
    if (!rule) continue;
    if (rule.failsWhen ? rule.failsWhen(a.value) : a.value.trim() !== '') return true;
  }
  return false;
}
