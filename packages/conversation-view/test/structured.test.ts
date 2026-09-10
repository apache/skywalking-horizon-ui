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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AszViewDocument } from '../src/index.js';
import { ConversationModel } from '../src/model.js';
import { drawStructured, structure, textBody } from '../src/view/structured.js';

const S = { copy: 'copy' };
const changes = JSON.parse(readFileSync(resolve('test/fixtures/workspace-changes.json'), 'utf8')) as AszViewDocument;
/** A Bash input from a real session, encoded the way the Sessionizer's Go
 *  encoder writes it and clipped at its 2,000 bytes. */
const clipped = JSON.parse(readFileSync(resolve('test/fixtures/clipped-bash-input.json'), 'utf8')) as { text: string; bytes: number };

describe('structure', () => {
  it('decodes the escapes the encoder wrote, so a command reads as it ran', () => {
    const text = new ConversationModel(changes).step('tool/s2-tool')!.text!;
    expect(text).toContain('\\u0026\\u0026');
    expect(structure(text)).toEqual({
      cut: false,
      fields: [{ key: 'command', value: "sed -i 's/= 10/= 30/' server.go && printf 'timeout: 30\\n' > config.yaml", block: false, cut: false }],
    });
  });

  it('reads a clipped object up to the cut and says which value it fell in', () => {
    const st = structure(clipped.text)!;
    expect(st.cut).toBe(true);
    expect(st.fields.map((f) => [f.key, f.block, f.cut])).toEqual([
      ['command', true, false],
      ['description', false, true],
    ]);
    expect(st.fields[0]!.value).toContain("cd /Users/dev/horizon/apps/bff\ncat > probe.ts <<'EOF'\n");
    expect(st.fields[0]!.value).toContain('2>&1 | head -c 900');
    expect(st.fields[1]!.value).toBe('Query the client-written data via BanyanDB');
  });

  it('stops at a cut that falls inside an escape', () => {
    expect(structure('{"command":"ls \\u00')).toEqual({ cut: true, fields: [{ key: 'command', value: 'ls ', block: false, cut: true }] });
    expect(structure('{"command":"ls \\')).toEqual({ cut: true, fields: [{ key: 'command', value: 'ls ', block: false, cut: true }] });
  });

  it('keeps numbers, booleans, null and nested values as their JSON text', () => {
    const st = structure('{"timeout": 120000, "ok": true, "none": null, "list": [1, "a]"], "obj": {"k": "v}"}}')!;
    expect(st.cut).toBe(false);
    expect(st.fields.map((f) => [f.key, f.value])).toEqual([
      ['timeout', '120000'],
      ['ok', 'true'],
      ['none', 'null'],
      ['list', '[1, "a]"]'],
      ['obj', '{"k": "v}"}'],
    ]);
  });

  it('puts a value with a newline, or a long one, on lines of its own', () => {
    const st = structure(`{"a":"x\\ny","b":"${'y'.repeat(81)}","c":"${'z'.repeat(80)}"}`)!;
    expect(st.fields.map((f) => f.block)).toEqual([true, true, false]);
  });

  it('leaves anything that is not one object alone', () => {
    expect(structure('build succeeded')).toBeNull();
    expect(structure('{}')).toBeNull();
    expect(structure('{"a":1} and more')).toBeNull();
    expect(structure('{"a" 1}')).toBeNull();
    expect(structure('{"a":"\\x"}')).toBeNull();
    expect(structure('{"a":nope}')).toBeNull();
    expect(structure('[1,2]')).toBeNull();
    expect(structure('{"a":1 "b":2}')).toBeNull();
    expect(structure('{"a":1,}')).toBeNull();
    expect(structure('{"a":[1}}')).toBeNull();
    expect(structure('{"a":{"b":nope}}')).toBeNull();
    expect(structure('{"command":"\\u"}')).toBeNull();
    expect(structure('{"command":"\\u00zz"}')).toBeNull();
  });
});

describe('drawStructured and textBody', () => {
  it('draws the short fields first, then the blocks, and an empty string as ""', () => {
    const html = drawStructured(structure('{"content":"a\\nb","file_path":"/x","note":""}')!, S);
    expect(html.indexOf('file_path')).toBeLessThan(html.indexOf('content'));
    expect(html).toContain('<span class="acv-field-key">note</span><span class="acv-field-value"><span class="acv-faint">""</span></span>');
    expect(html).toContain('<span class="acv-field-text">a\nb</span>');
  });

  it('marks the value the cut fell in', () => {
    expect(drawStructured(structure('{"a":"b')!, S)).toContain('b<span class="acv-field-cut">…</span>');
  });

  it('structures a tool call or an agent call only, and counts the lines a body takes', () => {
    expect(textBody('{"a":"b"}', 'message.assistant', S).html).not.toContain('acv-field');
    expect(textBody('{"prompt":"go"}', 'agent.call', S).html).toContain('acv-field-key');
    expect(textBody('{"command":"a\\nb\\nc"}', 'tool', S).lines).toBe(5);
    expect(textBody('{"a":"1","b":"2","c":"3","d":"4","e":"5","f":"6"}', 'tool', S).lines).toBe(7);
    expect(textBody('one\ntwo', 'tool', S).lines).toBe(2);
    expect(textBody('one\ntwo', 'tool', S)).toMatchObject({ fields: false, html: '<span class="acv-copy-text">one\ntwo</span>' });
    expect(textBody('{"a":"b"}', 'tool', S).fields).toBe(true);
    expect(textBody(clipped.text, 'tool', S).cut).toBe(true);
  });
});

describe('copy buttons and the edit diff', () => {
  it('gives every field a copy button', () => {
    const html = drawStructured(structure('{"command":"ls","description":"list"}')!, S);
    expect(html.match(/data-copy/g)).toHaveLength(2);
    expect(html).toContain('<button type="button" class="acv-copy" data-copy title="copy">copy</button>');
  });

  it('keeps a copy of each side of an edit, and copies an empty value as nothing', () => {
    const text = new ConversationModel(changes).step('tool/s3-tool')!.text!;
    const html = drawStructured(structure(text)!, S);
    expect(html.match(/acv-copy-src/g)).toHaveLength(2);
    expect(html).toContain('title="copy old_string"');
    expect(html).toContain('title="copy new_string"');
  });

  it('draws a clipped edit as its two sides, never as a diff against a prefix', () => {
    const text = '{"file_path":"a.go","old_string":"alpha\\nbeta\\ngamma","new_string":"alpha\\nb';
    const st = structure(text)!;
    expect(st.cut).toBe(true);
    const html = drawStructured(st, S);
    expect(html).not.toContain('acv-edit-diff');
    expect(html).toContain('<span class="acv-field-key">old_string</span>');
    expect(html).toContain('<span class="acv-field-key">new_string</span>');
    expect(html).toContain('alpha\nb<span class="acv-field-cut">…</span>');
  });

  it("draws an edit's old_string and new_string as one diff, the way git shows it", () => {
    const text = new ConversationModel(changes).step('tool/s3-tool')!.text!;
    const html = drawStructured(structure(text)!, S);
    expect(html).toContain('<span class="acv-field-key">file_path</span>');
    expect(html).toContain('<span class="acv-field-key">old_string → new_string</span>');
    expect(html).toContain('<div class="acv-diff-line del">-var timeout = 30</div>');
    expect(html).toContain('<div class="acv-diff-line add">+var timeoutSeconds = 30</div>');
    expect(html).not.toContain('<span class="acv-field-key">new_string</span>');
  });
});
