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
 * The vocabulary a TraceQL query is written in here: the intrinsics, the
 * attribute scopes, and the duration units.
 *
 * It is the SCHEMA — what a field is called and what it can be compared with —
 * and the editor's highlighting, completion and lint all read it. What a
 * backend does with a query written in it is the backend's own business and is
 * deliberately not modelled: see `layer/traceql/traceqlLint.ts`.
 */

/** Which datasources a schema entry belongs to. Absent means all of them. */
export type TraceQLStores = ReadonlyArray<'native' | 'zipkin' | 'otlp'>;

/** Intrinsic fields, which are bare by grammar and carry no scope. */
export const TRACEQL_INTRINSICS: ReadonlyArray<{ name: string; detail: string; ds?: TraceQLStores }> = [
  { name: 'duration', detail: 'Trace duration — >, >=, <, <= with us/µs/ms/s/m/h' },
  { name: 'name', detail: 'Span name' },
  { name: 'status', detail: 'ok, error or unset' },
  // A span kind is a column only where the spans were stored as OTLP; the
  // Zipkin and SkyWalking tag indexes have nothing to filter it on.
  { name: 'kind', detail: 'Span kind — server, client, producer, consumer, internal, unspecified (OTLP)', ds: ['otlp'] },
];

/** Attribute scopes. `span.` and the unscoped `.` reach the same tag lookup;
 *  `resource.` is meaningful for three reserved names and a tag otherwise. */
export const TRACEQL_SCOPES: ReadonlyArray<{ name: string; detail: string }> = [
  { name: 'span', detail: 'Span tag — span.http.method' },
  { name: 'resource', detail: 'Resource attribute — resource.service.name' },
];

/** The reserved resource attributes, which become entity filters rather than
 *  tag lookups. Which store defines which is not a detail: naming one the
 *  store does not have is the commonest way to write a query that cannot
 *  match, so each says where it applies. */
export const TRACEQL_RESOURCE_ATTRS: ReadonlyArray<{ name: string; detail: string; ds?: TraceQLStores }> = [
  { name: 'resource.service.name', detail: 'Service' },
  { name: 'resource.instance', detail: 'Service instance (native)', ds: ['native'] },
  { name: 'resource.service.instance.id', detail: 'Service instance (OTLP)', ds: ['otlp'] },
  { name: 'resource.remote.service', detail: 'Peer service (Zipkin, OTLP)', ds: ['zipkin', 'otlp'] },
];

/** The three values TraceQL's `status` intrinsic takes. */
export const TRACEQL_STATUS_VALUES = ['ok', 'error', 'unset'] as const;

export const TRACEQL_DURATION_UNITS = ['us', 'ms', 's', 'm', 'h'] as const;

export const TRACEQL_LANGUAGE_ID = 'traceql';

/** Monarch tokenizer for the language as TraceQL defines it. What a given
 *  backend does with a form it parses is that backend's business, so nothing
 *  here is coloured as wrong for being unsupported. */
export const TRACEQL_MONARCH = {
  defaultToken: '',
  tokenPostfix: '.traceql',
  intrinsics: TRACEQL_INTRINSICS.map((i) => i.name),
  scopes: TRACEQL_SCOPES.map((s) => s.name),
  tokenizer: {
    root: [
      [/[{}]/, 'delimiter.bracket'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/'(?:[^'\\]|\\.)*'/, 'string'],
      // A duration literal is a number with one of the accepted units.
      [/\d+(?:\.\d+)?(?:us|µs|ms|s|m|h)\b/, 'number'],
      [/\d+(?:\.\d+)?/, 'number'],
      [/!=|=~|!~|>=|<=|[<>]/, 'operator'],
      [/&&|\band\b/, 'operator'],
      [/\|\||\bor\b/, 'operator'],
      [/=/, 'operator'],
      [
        /[a-zA-Z_][\w.]*/,
        {
          cases: {
            '@intrinsics': 'keyword',
            '@scopes': 'type',
            '@default': 'identifier',
          },
        },
      ],
      [/[ \t\r\n]+/, 'white'],
    ],
  },
};

/** The comparisons TraceQL defines for a field — a duration is ordered, an
 *  attribute is matched. The schema panel prints these beside each field. */
export function operatorsFor(field: string): string[] {
  return field === 'duration' ? ['>', '>=', '<', '<='] : ['=', '!=', '=~', '!~'];
}
