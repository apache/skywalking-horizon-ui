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
 * Lightweight per-line syntax highlighter for the three DSLs Studio
 * shows in read-only viewers (OAL catalog file pane, debugger source
 * pane). Operates per-line so line-number gutters stay aligned —
 * the tokenizer never crosses a newline, no multi-line state.
 *
 * Why not Monaco? Monaco is overkill for a 200-line read-only view
 * and the bundle cost is already paid only on the editor route.
 * Regex-tokenisation here is ~80 lines, no dependency, and fast
 * enough that we re-tokenise on every render.
 *
 * The highlighter is intentionally **shallow**: it lights up
 * comments, strings, numbers, and a curated keyword + function set
 * per DSL. Identifiers and operators stay neutral. Operator wins
 * are: scanning a long `.oal` file for the right `from(...)` row,
 * spotting the chain method in a MAL `expSuffix`, and seeing where
 * a LAL block opens.
 */

export type SyntaxLang = 'oal' | 'mal' | 'lal';

export type TokenKind =
  | 'comment'
  | 'string'
  | 'keyword'
  | 'fn'
  | 'type'
  | 'number'
  | 'punct'
  | 'plain';

export interface Token {
  kind: TokenKind;
  text: string;
}

/** OAL DSL — top-level words and OAL function names. */
const OAL_KEYWORDS = new Set(['from', 'filter', 'disable']);
const OAL_FUNCS = new Set([
  'cpm',
  'sum',
  'sumPerMin',
  'avg',
  'longAvg',
  'doubleAvg',
  'count',
  'distinct',
  'rate',
  'percent',
  'p50',
  'p75',
  'p90',
  'p95',
  'p99',
  'histogram',
  'histogramPercentile',
  'apdex',
  'maxLong',
  'minLong',
  'maxDouble',
  'minDouble',
  'sumLabeled',
  'avgLabeled',
]);

/** OAL-side known type names (source classes + enums) operators
 *  scan for. Not exhaustive — the highlight is a hint, not a
 *  spec. */
const OAL_TYPES = new Set([
  'Service',
  'ServiceInstance',
  'ServiceRelation',
  'ServiceInstanceRelation',
  'Endpoint',
  'EndpointRelation',
  'DetectPoint',
  'Layer',
  'NodeType',
  'RequestType',
]);

/** LAL block / built-in names. */
const LAL_KEYWORDS = new Set([
  'filter',
  'extractor',
  'parser',
  'parsed',
  'sink',
  'tag',
  'metric',
  'regexp',
  'json',
  'yaml',
  'text',
  'rules',
  'dsl',
  'name',
  'abort',
  'if',
  'else',
  'envoyAccessLog',
]);

/** MAL chain methods + top-level YAML keys MAL rules use. */
const MAL_FUNCS = new Set([
  'sum',
  'avg',
  'histogram',
  'instance',
  'service',
  'endpoint',
  'serviceRelation',
  'endpointRelation',
  'serviceInstance',
  'meter',
  'tag',
  'retag',
  'filter',
  'sumLabeled',
  'avgLabeled',
  'maxHistogram',
  'minHistogram',
  'histogramPercentile',
  'rate',
  'irate',
  'aggregate',
  'increase',
  'foreach',
  'union',
  'process',
  'tagEqual',
  'tagNotEqual',
  'tagMatch',
  'tagNotMatch',
]);

const MAL_KEYWORDS = new Set([
  'filter',
  'expSuffix',
  'metricPrefix',
  'metricsRules',
  'name',
  'exp',
  'doc',
  'unit',
]);

const RE_LINE_COMMENT = /^(?:\/\/|#)/;
const RE_STRING_SQ = /^'(?:\\.|[^'\\])*'/;
const RE_STRING_DQ = /^"(?:\\.|[^"\\])*"/;
const RE_NUMBER = /^-?\d+(?:\.\d+)?\b/;
const RE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const RE_PUNCT = /^[(){}[\].,;:=<>!+\-*/&|]+/;
const RE_WS = /^\s+/;

function classifyIdent(text: string, lang: SyntaxLang): TokenKind {
  if (lang === 'oal') {
    if (OAL_KEYWORDS.has(text)) return 'keyword';
    if (OAL_FUNCS.has(text)) return 'fn';
    if (OAL_TYPES.has(text)) return 'type';
    return 'plain';
  }
  if (lang === 'lal') {
    if (LAL_KEYWORDS.has(text)) return 'keyword';
    return 'plain';
  }
  // MAL
  if (MAL_KEYWORDS.has(text)) return 'keyword';
  if (MAL_FUNCS.has(text)) return 'fn';
  return 'plain';
}

/** Tokenise a single line. Newline-free input expected; the caller
 *  splits the body and passes one line at a time so the gutter
 *  stays aligned. Multi-line strings are uncommon in these DSLs and
 *  intentionally rendered as single-line plain text on each line if
 *  they appear. */
export function tokenizeLine(line: string, lang: SyntaxLang): Token[] {
  const out: Token[] = [];
  let s = line;

  while (s.length > 0) {
    if (RE_LINE_COMMENT.test(s)) {
      out.push({ kind: 'comment', text: s });
      break;
    }

    let m: RegExpMatchArray | null;

    if ((m = s.match(RE_WS))) {
      out.push({ kind: 'plain', text: m[0] });
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(RE_STRING_SQ)) || (m = s.match(RE_STRING_DQ))) {
      out.push({ kind: 'string', text: m[0] });
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(RE_NUMBER))) {
      out.push({ kind: 'number', text: m[0] });
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(RE_IDENT))) {
      out.push({ kind: classifyIdent(m[0], lang), text: m[0] });
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(RE_PUNCT))) {
      out.push({ kind: 'punct', text: m[0] });
      s = s.slice(m[0].length);
      continue;
    }
    // Unrecognised single char — emit as plain to make forward
    // progress; the tokeniser is permissive on purpose.
    out.push({ kind: 'plain', text: s[0]! });
    s = s.slice(1);
  }
  return out;
}
