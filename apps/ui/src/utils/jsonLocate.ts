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
 * Where in a JSON text a value sits. `JSON.parse` returns values without
 * positions, so anything that has to point at a place in the text — an
 * editor marker on a template problem — scans it here instead. The grammar
 * is exactly `JSON.parse`'s (RFC 8259: no comments, no trailing commas, no
 * BOM), so the two always agree on whether a text is valid.
 */

/** A character range in the scanned text: `text.slice(offset, offset + length)`. */
export interface JsonRange {
  offset: number;
  length: number;
}

interface Span {
  start: number;
  end: number;
}

interface Prop {
  key: Span;
  value: JsonNode;
}

type JsonNode =
  | { kind: 'object'; start: number; end: number; props: Map<string, Prop> }
  | { kind: 'array'; start: number; end: number; items: JsonNode[] }
  | { kind: 'scalar'; start: number; end: number };

class JsonScanError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
  }
}

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_SPACE = 0x20;
const CH_QUOTE = 0x22;
const CH_PLUS = 0x2b;
const CH_COMMA = 0x2c;
const CH_MINUS = 0x2d;
const CH_DOT = 0x2e;
const CH_0 = 0x30;
const CH_9 = 0x39;
const CH_COLON = 0x3a;
const CH_LBRACKET = 0x5b;
const CH_BACKSLASH = 0x5c;
const CH_RBRACKET = 0x5d;
const CH_LBRACE = 0x7b;
const CH_RBRACE = 0x7d;

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

function isDigit(c: number): boolean {
  return c >= CH_0 && c <= CH_9;
}

function isHex(c: number): boolean {
  return isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

function describeChar(c: number): string {
  return c > CH_SPACE && c < 0x7f
    ? `'${String.fromCharCode(c)}'`
    : `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
}

function scan(text: string): JsonNode {
  let pos = 0;

  function fail(at: number, message: string): never {
    throw new JsonScanError(at, message);
  }
  function failHere(expected: string): never {
    return pos >= text.length ? fail(pos, 'Unexpected end of input') : fail(pos, expected);
  }

  function skipWs(): void {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c !== CH_SPACE && c !== CH_TAB && c !== CH_LF && c !== CH_CR) return;
      pos++;
    }
  }

  /** Scans the string at `pos` (on its opening quote); returns the decoded
   *  value only when asked, since only property keys are ever compared. */
  function scanString(decode: boolean): string {
    pos++;
    let out = '';
    let runStart = pos;
    for (;;) {
      if (pos >= text.length) fail(pos, 'Unterminated string');
      const c = text.charCodeAt(pos);
      if (c === CH_QUOTE) {
        if (decode) out += text.slice(runStart, pos);
        pos++;
        return out;
      }
      if (c < CH_SPACE) fail(pos, 'Bad control character in string');
      if (c !== CH_BACKSLASH) {
        pos++;
        continue;
      }
      if (decode) out += text.slice(runStart, pos);
      pos++;
      if (pos >= text.length) fail(pos, 'Unterminated string');
      const esc = text[pos]!;
      if (esc === 'u') {
        for (let i = 1; i <= 4; i++) {
          if (pos + i >= text.length) fail(pos + i, 'Unterminated string');
          if (!isHex(text.charCodeAt(pos + i))) fail(pos + i, 'Bad Unicode escape');
        }
        if (decode) out += String.fromCharCode(parseInt(text.slice(pos + 1, pos + 5), 16));
        pos += 5;
      } else {
        const simple = SIMPLE_ESCAPES[esc];
        if (simple === undefined) fail(pos, 'Bad escape character');
        if (decode) out += simple;
        pos++;
      }
      runStart = pos;
    }
  }

  function digits(): void {
    if (pos >= text.length || !isDigit(text.charCodeAt(pos))) failHere('Expected a digit');
    while (pos < text.length && isDigit(text.charCodeAt(pos))) pos++;
  }

  function scanNumber(): void {
    if (text.charCodeAt(pos) === CH_MINUS) pos++;
    if (text.charCodeAt(pos) === CH_0) pos++;
    else digits();
    if (text.charCodeAt(pos) === CH_DOT) {
      pos++;
      digits();
    }
    const e = text.charCodeAt(pos);
    if (e === 0x65 || e === 0x45) {
      pos++;
      const sign = text.charCodeAt(pos);
      if (sign === CH_PLUS || sign === CH_MINUS) pos++;
      digits();
    }
  }

  function scanLiteral(word: string): void {
    for (let i = 0; i < word.length; i++) {
      if (text[pos] !== word[i]) failHere(`Expected "${word}"`);
      pos++;
    }
  }

  function scanObject(): JsonNode {
    const start = pos;
    const props = new Map<string, Prop>();
    pos++;
    skipWs();
    if (text.charCodeAt(pos) === CH_RBRACE) {
      pos++;
      return { kind: 'object', start, end: pos, props };
    }
    for (;;) {
      if (text.charCodeAt(pos) !== CH_QUOTE) failHere('Expected a double-quoted property name');
      const keyStart = pos;
      const name = scanString(true);
      const key = { start: keyStart, end: pos };
      skipWs();
      if (text.charCodeAt(pos) !== CH_COLON) failHere("Expected ':' after property name");
      pos++;
      skipWs();
      // A repeated name overwrites, so the last duplicate wins, as in JSON.parse.
      props.set(name, { key, value: scanValue() });
      skipWs();
      const c = text.charCodeAt(pos);
      if (c === CH_RBRACE) {
        pos++;
        return { kind: 'object', start, end: pos, props };
      }
      if (c !== CH_COMMA) failHere("Expected ',' or '}' after property value");
      pos++;
      skipWs();
      if (text.charCodeAt(pos) === CH_RBRACE) fail(pos, 'Trailing comma');
    }
  }

  function scanArray(): JsonNode {
    const start = pos;
    const items: JsonNode[] = [];
    pos++;
    skipWs();
    if (text.charCodeAt(pos) === CH_RBRACKET) {
      pos++;
      return { kind: 'array', start, end: pos, items };
    }
    for (;;) {
      items.push(scanValue());
      skipWs();
      const c = text.charCodeAt(pos);
      if (c === CH_RBRACKET) {
        pos++;
        return { kind: 'array', start, end: pos, items };
      }
      if (c !== CH_COMMA) failHere("Expected ',' or ']' after array element");
      pos++;
      skipWs();
      if (text.charCodeAt(pos) === CH_RBRACKET) fail(pos, 'Trailing comma');
    }
  }

  function scanValue(): JsonNode {
    const start = pos;
    const c = text.charCodeAt(pos);
    if (c === CH_LBRACE) return scanObject();
    if (c === CH_LBRACKET) return scanArray();
    if (c === CH_QUOTE) scanString(false);
    else if (c === CH_MINUS || isDigit(c)) scanNumber();
    else if (c === 0x74) scanLiteral('true');
    else if (c === 0x66) scanLiteral('false');
    else if (c === 0x6e) scanLiteral('null');
    else failHere(`Unexpected character ${describeChar(c)}`);
    return { kind: 'scalar', start, end: pos };
  }

  skipWs();
  const root = scanValue();
  skipWs();
  if (pos < text.length) fail(pos, 'Unexpected content after the end of the JSON value');
  return root;
}

type ScanResult = { ok: true; root: JsonNode } | { ok: false; offset: number; message: string };

// One entry: the problems dialog asks for every problem's range against the
// same text, and each call would otherwise rescan the whole document.
let memo: { text: string; result: ScanResult } | null = null;

function scanMemo(text: string): ScanResult {
  if (memo?.text === text) return memo.result;
  let result: ScanResult;
  try {
    result = { ok: true, root: scan(text) };
  } catch (err) {
    if (!(err instanceof JsonScanError)) throw err;
    result = { ok: false, offset: err.offset, message: err.message };
  }
  memo = { text, result };
  return result;
}

function child(node: JsonNode, seg: string | number): { key: Span | null; value: JsonNode } | null {
  if (node.kind === 'object') {
    const prop = node.props.get(String(seg));
    return prop ? { key: prop.key, value: prop.value } : null;
  }
  if (node.kind === 'array') {
    const index = typeof seg === 'number' ? seg : /^\d+$/.test(seg) ? Number(seg) : -1;
    const item = Number.isInteger(index) && index >= 0 ? node.items[index] : undefined;
    return item ? { key: null, value: item } : null;
  }
  return null;
}

function rangeOf(span: Span): JsonRange {
  return { offset: span.start, length: span.end - span.start };
}

/**
 * The range of the value at `path` in the JSON `text`, or null when `text`
 * is not valid JSON. A segment names an object property by its string form
 * and indexes an array when it is a number or a digit string; a property
 * name that repeats resolves to its last occurrence, as in `JSON.parse`.
 *
 * - Path found: the value's whole range — `{…}` / `[…]` included, a
 *   string with its quotes. An empty path is the root value, i.e. the
 *   whole document without surrounding whitespace.
 * - Path not found (a missing key, an index past the end, a step into a
 *   scalar): the location of the DEEPEST ancestor that does exist —
 *     - reached through an object property → that property's key token,
 *       quotes included, so the mark sits on the object lacking the key;
 *     - an array element, or the root → its first token: the opening `{`
 *       or `[` of a container (one character, so a large element is not
 *       underlined end to end), or the whole token of a scalar.
 */
export function locateJsonPath(text: string, path: ReadonlyArray<string | number>): JsonRange | null {
  const scanned = scanMemo(text);
  if (!scanned.ok) return null;
  let node = scanned.root;
  let key: Span | null = null;
  for (const seg of path) {
    const next = child(node, seg);
    if (!next) {
      if (key) return rangeOf(key);
      return node.kind === 'scalar' ? rangeOf(node) : { offset: node.start, length: 1 };
    }
    node = next.value;
    key = next.key;
  }
  return rangeOf(node);
}

/**
 * The first syntax error in `text`, or null when it is valid JSON. `offset`
 * is the character where the text stops being JSON — the same position
 * `JSON.parse` reports — and `text.length` for input that ends too early.
 * The message is short English, for display next to the mark.
 */
export function jsonSyntaxError(text: string): { offset: number; message: string } | null {
  const scanned = scanMemo(text);
  return scanned.ok ? null : { offset: scanned.offset, message: scanned.message };
}
