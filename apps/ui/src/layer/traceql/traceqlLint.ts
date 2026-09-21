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
 * Whether a query names fields this store's schema has.
 *
 * That is the whole job. What a backend then DOES with a form it parsed — apply
 * it, ignore it, refuse the query — is the backend's business and differs
 * between builds, so nothing here predicts it: a message that describes one
 * OAP's parser is wrong for the next one, and a wrong answer to a query it
 * accepted is a bug to report upstream rather than a rule to encode here.
 *
 * So two kinds of finding, both WARNINGS, and the query always runs:
 * the expression is not a well-formed spanset, or it names a field the schema
 * does not have.
 */

import type { TraceQLDatasource } from '@skywalking-horizon-ui/api-client';
import {
  TRACEQL_INTRINSICS,
  TRACEQL_RESOURCE_ATTRS,
  TRACEQL_SCOPES,
} from '@/monaco/traceql-grammar';

export interface TraceQLIssue {
  /** Stable id, so a message can be translated and a rule can be tested. */
  id: string;
  /** The text this fired on, for the operator to find in their query. */
  found: string;
}

/** Identifiers and operators are matched on a copy with the literals blanked —
 *  a service called "or", or a message containing "!=", is not syntax. Blanked
 *  to the same length so offsets still line up with what was typed. */
function withoutLiterals(q: string): string {
  return q.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => ' '.repeat(m.length));
}

const INTRINSIC_NAMES = new Set(TRACEQL_INTRINSICS.map((i) => i.name));
const SCOPE_PREFIXES = TRACEQL_SCOPES.map((s) => `${s.name}.`);

/** The left-hand side of every condition, with its operator. */
const CONDITIONS = /(?:^|[\s{(&|!])((?:\.|[A-Za-z_])[\w.]*)\s*(?:>=|<=|!=|=~|!~|[<>=])/g;

/**
 * A field the schema does not have.
 *
 * TraceQL spells an attribute with its scope — `span.http.method`,
 * `resource.service.name` — or with a LEADING DOT for the unscoped form,
 * `.http.method`. The intrinsics are bare by grammar and carry no dot, which is
 * how the two are told apart. Anything else is a name this schema cannot place:
 * `http.method` written bare, or a scope it does not define.
 *
 * The TAG NAMES a store reports are deliberately not checked against. That list
 * is what the store saw in the window being queried, not the set of tags that
 * exist, so a tag nothing happened to carry in the last hour would be reported
 * as a typo.
 */
function fieldIssue(field: string): string | null {
  if (field.startsWith('.')) return null;
  if (SCOPE_PREFIXES.some((p) => field.startsWith(p))) return null;
  if (INTRINSIC_NAMES.has(field)) return null;
  return field.includes('.') ? 'unscoped-attribute' : 'unknown-field';
}

/** An expression that is not one complete spanset, or a condition left without
 *  a value — neither can be read as the query the operator meant. */
function structuralIssue(text: string, syntax: string): TraceQLIssue | null {
  const opens = (syntax.match(/\{/g) ?? []).length;
  const closes = (syntax.match(/\}/g) ?? []).length;
  if (opens !== closes || !text.startsWith('{') || !text.endsWith('}')) {
    return { id: 'incomplete-spanset', found: text.slice(0, 24) };
  }
  // A condition with nothing after its operator. Literals are blanked for the
  // field scan, which would make every string condition LOOK empty — so this
  // one reads a copy where each literal stands as a single placeholder.
  const withPlaceholders = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '§');
  const empty = /([\w.]+\s*(?:>=|<=|!=|=~|!~|[<>=]))\s*(?:&&|\|\||\}|$)/.exec(withPlaceholders);
  // The condition itself, without the brace or the `&&` that followed it —
  // `duration>}` named a bracket the operator did not type as part of it.
  if (empty) return { id: 'empty-value', found: empty[1]!.trim() };
  return null;
}

/** Every issue in `q`. An empty expression is fine — it is the match-all `{}`.
 *  `ds` picks the schema, whose fields differ between the three stores. */
export function lintTraceQL(q: string, ds: TraceQLDatasource = 'native'): TraceQLIssue[] {
  const text = q.trim();
  if (!text) return [];
  const syntax = withoutLiterals(text);
  const out: TraceQLIssue[] = [];
  const structural = structuralIssue(text, syntax);
  if (structural) out.push(structural);

  const seen = new Set<string>();
  for (const m of syntax.matchAll(CONDITIONS)) {
    const field = m[1]!;
    if (seen.has(field)) continue;
    seen.add(field);
    const id = fieldIssue(field);
    if (id) out.push({ id, found: field });
  }

  // A field ANOTHER datasource defines: the schema panel lists what this store
  // has, and a name from a different one cannot match here.
  const foreign = [...TRACEQL_RESOURCE_ATTRS, ...TRACEQL_INTRINSICS]
    .filter((a) => a.ds && !a.ds.includes(ds));
  for (const attr of foreign) {
    if (new RegExp(`(?:^|[\\s{(&|!])${attr.name.replace(/\./g, '\\.')}\\s*(?:!=|=~|!~|=)`).test(syntax)) {
      out.push({ id: 'other-store-attribute', found: attr.name });
    }
  }

  // The status VALUE is a literal, so it is read from the original text. The
  // boundary keeps the INTRINSIC apart from a span tag that happens to be
  // called status — `span.status` is an attribute and takes any value.
  const status = /(?:^|[\s{(&|!])status\s*(?:!=|=)\s*"?([A-Za-z_]+)"?/.exec(text);
  if (status && !['ok', 'error', 'unset'].includes(status[1]!)) {
    out.push({ id: 'status-vocabulary', found: status[1]! });
  }
  return out;
}


/** Conditions the builder can offer, in the order the rows read. It emits the
 *  equality form only — a builder is for the query you can point at. */
export interface BuilderRows {
  service?: string;
  spanName?: string;
  status?: 'ok' | 'error' | 'unset' | '';
  minDuration?: string;
  maxDuration?: string;
  instance?: string;
  remoteService?: string;
  tags?: Array<{ key: string; value: string }>;
}

/** The expression the builder generates — one spanset, equality only. The
 *  editor is there for everything the language can say beyond that. */
/** A value goes in as a literal, so quotes and backslashes in it are escaped
 *  rather than allowed to end the string early. */
function lit(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The service a hand-written expression filters on, or null.
 *
 * Span names resolve against a service upstream, so completing `name=` needs
 * to know which one the OPERATOR named — in TraceQL mode the builder's picker
 * says nothing about the sentence being typed.
 */
export function serviceInExpression(q: string): string | null {
  const m = /resource\.service\.name\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(q);
  if (!m) return null;
  return m[1]!.replace(/\\(["\\])/g, '$1');
}

export function buildTraceQL(rows: BuilderRows): string {
  const parts: string[] = [];
  if (rows.service) parts.push(`resource.service.name=${lit(rows.service)}`);
  // Instance and span name are resolved against a service id, so alone they
  // filter nothing. The builder only offers them once a service is chosen.
  if (rows.service && rows.instance) parts.push(`resource.instance=${lit(rows.instance)}`);
  if (rows.service && rows.remoteService) parts.push(`resource.remote.service=${lit(rows.remoteService)}`);
  if (rows.spanName) parts.push(`name=${lit(rows.spanName)}`);
  if (rows.status) parts.push(`status=${lit(rows.status)}`);
  if (rows.minDuration) parts.push(`duration>${rows.minDuration}`);
  if (rows.maxDuration) parts.push(`duration<${rows.maxDuration}`);
  for (const t of rows.tags ?? []) {
    if (t.key && t.value) parts.push(`span.${t.key}=${lit(t.value)}`);
  }
  return `{${parts.join(' && ')}}`;
}
