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

import { describe, expect, it } from 'vitest';
import { jsonSyntaxError, locateJsonPath, type JsonRange } from './jsonLocate';

function slice(text: string, range: JsonRange | null): string | null {
  return range ? text.slice(range.offset, range.offset + range.length) : null;
}

const TEMPLATE = {
  name: 'horizon.layer.GENERAL',
  content: {
    key: 'GENERAL',
    components: { service: { tabs: ['overview', 'topology'] } },
    dashboards: {
      service: [
        { title: 'Apdex', expressions: ['service_apdex/10000'] },
        { title: 'Load', expressions: ['service_cpm'] },
        { title: 'Latency', expressions: [] },
        { title: 'Odd "quotes" {and} [brackets]', expressions: ['a', 'b'], unit: null, top: 5, ratio: -1.5e-3 },
      ],
    },
    flags: { on: true, off: false },
  },
};

const PRETTY = JSON.stringify(TEMPLATE, null, 2);
const COMPACT = JSON.stringify(TEMPLATE);

describe('locateJsonPath', () => {
  for (const [label, text] of [
    ['pretty-printed', PRETTY],
    ['compact', COMPACT],
  ] as const) {
    it(`finds nested object and array values in ${label} text`, () => {
      expect(slice(text, locateJsonPath(text, ['content', 'key']))).toBe('"GENERAL"');
      expect(slice(text, locateJsonPath(text, ['content', 'components', 'service', 'tabs', 1]))).toBe('"topology"');
      expect(slice(text, locateJsonPath(text, ['content', 'dashboards', 'service', 1, 'expressions', 0]))).toBe(
        '"service_cpm"',
      );
      expect(slice(text, locateJsonPath(text, ['content', 'dashboards', 'service', 3, 'top']))).toBe('5');
      expect(slice(text, locateJsonPath(text, ['content', 'dashboards', 'service', 3, 'ratio']))).toBe('-0.0015');
      expect(slice(text, locateJsonPath(text, ['content', 'dashboards', 'service', 3, 'unit']))).toBe('null');
      expect(slice(text, locateJsonPath(text, ['content', 'flags', 'off']))).toBe('false');
    });

    it(`returns a container value whole in ${label} text`, () => {
      const range = locateJsonPath(text, ['content', 'dashboards', 'service', 2]);
      expect(JSON.parse(slice(text, range)!)).toEqual(TEMPLATE.content.dashboards.service[2]);
    });

    it(`agrees with JSON.parse for every path in ${label} text`, () => {
      const walk = (value: unknown, path: Array<string | number>): void => {
        expect(JSON.parse(slice(text, locateJsonPath(text, path))!)).toEqual(value);
        if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
        else if (value !== null && typeof value === 'object') {
          for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
        }
      };
      walk(TEMPLATE, []);
    });
  }

  it('skips braces, brackets and quotes inside strings', () => {
    const text = '{"a":"x}\\"{[,:","b":{"c\\"}":"]\\\\","d":[ "}" , {"e":"\\u007b"} ]}}';
    expect(slice(text, locateJsonPath(text, ['a']))).toBe('"x}\\"{[,:"');
    expect(slice(text, locateJsonPath(text, ['b', 'c"}']))).toBe('"]\\\\"');
    expect(slice(text, locateJsonPath(text, ['b', 'd', 0]))).toBe('"}"');
    expect(slice(text, locateJsonPath(text, ['b', 'd', 1, 'e']))).toBe('"\\u007b"');
  });

  it('matches property names by their decoded value', () => {
    const text = '{"k\\u0065y": 1, "tab\\tbed": 2, "\\ud83d\\ude00": 3}';
    expect(slice(text, locateJsonPath(text, ['key']))).toBe('1');
    expect(slice(text, locateJsonPath(text, ['tab\tbed']))).toBe('2');
    expect(slice(text, locateJsonPath(text, ['\u{1F600}']))).toBe('3');
  });

  it('resolves a repeated property name to its last occurrence, as JSON.parse does', () => {
    const text = '{"a": 1, "b": {"x": 1}, "a": [2]}';
    expect(slice(text, locateJsonPath(text, ['a']))).toBe('[2]');
    expect(slice(text, locateJsonPath(text, ['a', 0]))).toBe('2');
    expect(slice(text, locateJsonPath(text, ['a', 'missing']))).toBe('"a"');
    expect(locateJsonPath(text, ['a', 'missing'])!.offset).toBe(text.lastIndexOf('"a"'));
  });

  it('returns the root value, without surrounding whitespace, for an empty path', () => {
    const text = '\n  {"a": [1, 2]}  \n';
    expect(slice(text, locateJsonPath(text, []))).toBe('{"a": [1, 2]}');
    expect(slice(' 42 ', locateJsonPath(' 42 ', []))).toBe('42');
  });

  describe('a path that does not exist', () => {
    it('marks the key of the deepest existing property when a key is missing', () => {
      expect(slice(PRETTY, locateJsonPath(PRETTY, ['content', 'missing']))).toBe('"content"');
      expect(slice(PRETTY, locateJsonPath(PRETTY, ['content', 'components', 'endpoint', 'tabs']))).toBe(
        '"components"',
      );
    });

    it('marks the key of the array property when an index is past its end', () => {
      expect(slice(PRETTY, locateJsonPath(PRETTY, ['content', 'dashboards', 'service', 9, 'title']))).toBe(
        '"service"',
      );
    });

    it('marks the key of a scalar property the path tries to step into', () => {
      expect(slice(PRETTY, locateJsonPath(PRETTY, ['content', 'key', 'deeper']))).toBe('"key"');
    });

    it('marks the opening bracket of an array element that lacks the key', () => {
      const range = locateJsonPath(COMPACT, ['content', 'dashboards', 'service', 2, 'unit']);
      expect(range!.length).toBe(1);
      expect(COMPACT[range!.offset]).toBe('{');
      expect(range!.offset).toBe(locateJsonPath(COMPACT, ['content', 'dashboards', 'service', 2])!.offset);
    });

    it('marks a scalar array element whole when the path steps into it', () => {
      const text = '[10, "abc"]';
      expect(slice(text, locateJsonPath(text, [1, 'x']))).toBe('"abc"');
    });

    it('marks the root opening bracket when the root lacks the key', () => {
      const text = '  {"a": 1}';
      expect(locateJsonPath(text, ['b'])).toEqual({ offset: 2, length: 1 });
      expect(locateJsonPath('[1]', [3])).toEqual({ offset: 0, length: 1 });
    });

    it('indexes an array with a digit string and names a property with a number', () => {
      const text = '{"list": [7, 8], "map": {"0": "zero"}}';
      expect(slice(text, locateJsonPath(text, ['list', '1']))).toBe('8');
      expect(slice(text, locateJsonPath(text, ['list', 'x']))).toBe('"list"');
      expect(slice(text, locateJsonPath(text, ['map', 0]))).toBe('"zero"');
    });
  });

  it('returns null for text that is not valid JSON', () => {
    expect(locateJsonPath('{"a": 1,}', ['a'])).toBeNull();
    expect(locateJsonPath('', [])).toBeNull();
    expect(locateJsonPath('not json', [])).toBeNull();
  });
});

describe('jsonSyntaxError', () => {
  it('returns null for valid JSON', () => {
    for (const text of [PRETTY, COMPACT, '0', '-0.5E+10', '"\\u00e9\\/"', ' [ ] ', '{}', 'null', '\t\r\n true \n']) {
      expect(jsonSyntaxError(text)).toBeNull();
    }
  });

  const cases: Array<{ name: string; text: string; offset: number; message: string }> = [
    { name: 'empty input', text: '', offset: 0, message: 'Unexpected end of input' },
    { name: 'truncated object', text: '{"a":1', offset: 6, message: 'Unexpected end of input' },
    {
      name: 'truncated pretty text',
      text: PRETTY.slice(0, PRETTY.indexOf('"components"')),
      offset: PRETTY.indexOf('"components"'),
      message: 'Unexpected end of input',
    },
    { name: 'truncated string', text: '{"a":"abc', offset: 9, message: 'Unterminated string' },
    { name: 'truncated literal', text: '[tru', offset: 4, message: 'Unexpected end of input' },
    { name: 'trailing comma in an object', text: '{"a":1,}', offset: 7, message: 'Trailing comma' },
    { name: 'trailing comma in an array', text: '[1, 2, ]', offset: 7, message: 'Trailing comma' },
    { name: 'trailing comma, nested and pretty', text: '{\n  "a": [\n    1,\n  ]\n}', offset: 20, message: 'Trailing comma' },
    { name: 'a bare word', text: '{"a": x}', offset: 6, message: "Unexpected character 'x'" },
    { name: 'a misspelled literal', text: '{"a": tRue}', offset: 7, message: 'Expected "true"' },
    { name: 'an unquoted key', text: '{a: 1}', offset: 1, message: 'Expected a double-quoted property name' },
    { name: 'a single-quoted string', text: "['a']", offset: 1, message: "Unexpected character '''" },
    { name: 'a missing colon', text: '{"a" 1}', offset: 5, message: "Expected ':' after property name" },
    { name: 'a missing comma in an object', text: '{"a":1 "b":2}', offset: 7, message: "Expected ',' or '}' after property value" },
    { name: 'a missing comma in an array', text: '[1 2]', offset: 3, message: "Expected ',' or ']' after array element" },
    { name: 'a leading zero', text: '[01]', offset: 2, message: "Expected ',' or ']' after array element" },
    { name: 'a minus without digits', text: '-', offset: 1, message: 'Unexpected end of input' },
    { name: 'a fraction without digits', text: '[1.]', offset: 3, message: 'Expected a digit' },
    { name: 'an exponent without digits', text: '1e+', offset: 3, message: 'Unexpected end of input' },
    { name: 'a leading plus', text: '+1', offset: 0, message: "Unexpected character '+'" },
    { name: 'a bad escape', text: '"a\\x"', offset: 3, message: 'Bad escape character' },
    { name: 'a bad Unicode escape', text: '"\\u12G4"', offset: 5, message: 'Bad Unicode escape' },
    { name: 'a raw newline in a string', text: '"a\nb"', offset: 2, message: 'Bad control character in string' },
    { name: 'a byte-order mark', text: '﻿{}', offset: 0, message: 'Unexpected character U+FEFF' },
    { name: 'content after the value', text: '{"a":1} {"b":2}', offset: 8, message: 'Unexpected content after the end of the JSON value' },
    { name: 'a comment', text: '{"a":1 // note\n}', offset: 7, message: "Expected ',' or '}' after property value" },
  ];
  for (const c of cases) {
    it(`reports ${c.name}`, () => {
      expect(() => JSON.parse(c.text)).toThrow();
      expect(jsonSyntaxError(c.text)).toEqual({ offset: c.offset, message: c.message });
    });
  }

  it('agrees with JSON.parse on validity, and on the position wherever JSON.parse names one', () => {
    // A seeded generator, so a failure reproduces.
    let seed = 0x5eed;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = '{}[]":,\\ \n0123456789-+.eEtrufalsn"u';
    let invalid = 0;
    let positioned = 0;
    for (let round = 0; round < 3000; round++) {
      let text = round % 2 === 0 ? COMPACT : PRETTY;
      for (let edits = 1 + rand(3); edits > 0; edits--) {
        const at = rand(text.length + 1);
        const ch = alphabet[rand(alphabet.length)]!;
        const op = rand(3);
        text = op === 0 ? text.slice(0, at) + text.slice(at + 1) : text.slice(0, at) + ch + text.slice(at + (op === 1 ? 1 : 0));
      }
      let parseError: string | null = null;
      try {
        JSON.parse(text);
      } catch (err) {
        parseError = (err as Error).message;
      }
      const ours = jsonSyntaxError(text);
      expect(ours === null, text).toBe(parseError === null);
      const position = parseError ? /at position (\d+)/.exec(parseError) : null;
      if (ours) invalid++;
      if (ours && position) {
        positioned++;
        expect(ours.offset, `${text}\n${parseError}`).toBe(Number(position[1]));
      }
    }
    // The corpus must actually exercise both checks.
    expect(invalid).toBeGreaterThan(1000);
    expect(positioned).toBeGreaterThan(500);
  });
});
