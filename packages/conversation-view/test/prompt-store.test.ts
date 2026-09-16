/*
 * Licensed to Apache Software Foundation (ASF) under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Apache Software Foundation (ASF) licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PromptError, PromptStore, rawPartData, readProviderFile } from '../src/prompt/store.js';
import { sha256Hex } from '../src/prompt/sha256.js';
import type { AszViewDocument } from '../src/types.js';

/** The Sessionizer's provider-bodies scenario, landed: one file of fourteen bodies, and the document
 *  the Sessionizer prints for it, which the OAP's own tests hold too. */
const file = new Uint8Array(readFileSync(resolve('test/fixtures/provider-bodies.sd')));
const doc = JSON.parse(readFileSync(resolve('test/fixtures/provider-bodies.json'), 'utf8')) as AszViewDocument;
const SEQ = 4;

function store(): PromptStore {
  const s = new PromptStore();
  s.addFile({ seq: SEQ, file: 'provider_body.sd', bytes: file });
  return s;
}

describe('the provider body reader', () => {
  it('rebuilds every body of the file to its own digest', () => {
    const s = store();
    const records = readProviderFile(SEQ, file);
    expect(records).toHaveLength(14);
    for (const r of records) {
      const body = s.bodyAt(SEQ, r.row);
      expect(body.length).toBe(r.manifest.bytes);
      expect(createHash('sha256').update(body).digest('hex')).toBe(r.manifest.sha256);
    }
  });

  it('rebuilds what the document points at, and reads as the runtime wrote it', () => {
    const s = store();
    const refs: Array<{ role: string; seq: number; row: number }> = [];
    const walk = (nodes: AszViewDocument['talks']): void => {
      for (const n of nodes) {
        for (const b of (n as { provider_bodies?: Array<{ role: string; ref: { seq: number; row: number } }> }).provider_bodies ?? []) {
          refs.push({ role: b.role, seq: b.ref.seq, row: b.ref.row });
        }
        walk(n.children ?? []);
      }
    };
    walk(doc.talks);
    walk(doc.loose ?? []);
    expect(refs).toHaveLength(14);
    for (const ref of refs) {
      const body = JSON.parse(new TextDecoder().decode(s.bodyAt(ref.seq, ref.row))) as Record<string, unknown>;
      expect(typeof body['model']).toBe('string');
      // a request carries what it sent, a response what came back
      if (ref.role === 'request') expect(Array.isArray(body['messages'])).toBe(true);
      else expect(typeof body['id']).toBe('string');
    }
  });

  it('carries the keys a reader joins by', () => {
    const s = store();
    const first = s.manifestAt(SEQ, 1)!;
    expect(first.role).toBe('request');
    expect(first.run).toBeTruthy();
    const response = s.manifestAt(SEQ, 2)!;
    expect(response.role).toBe('response');
    expect(response.call).toBeTruthy();
    expect(s.responseOfRequestId(response.request!)?.manifest.call).toBe(response.call);
  });

  it('says what it cannot rebuild, and holds nothing a reference cannot answer', () => {
    const s = store();
    expect(() => s.bodyAt(SEQ, 99)).toThrow(PromptError);
    expect(() => s.bodyAt(9, 1)).toThrow(PromptError);
    // a body that refers to an earlier record is not held when that record is not there: the file it
    // came from is what a reader must load, in landing order
    const lines = new TextDecoder().decode(file).split('\n');
    const records = readProviderFile(SEQ, file);
    const refers = records.findIndex((r) => r.manifest.segments.some((seg) => seg.copy || seg.piece));
    expect(refers).toBeGreaterThan(0);
    const alone = new PromptStore();
    alone.addFile({
      seq: 9,
      file: 'x.sd',
      bytes: new TextEncoder().encode([lines[0], lines[records[refers]!.row], lines[lines.length - 2]].join('\n') + '\n'),
    });
    expect(() => alone.bodyAt(9, 1)).toThrow(PromptError);
  });

  it('takes a part as the line spells it, escapes and all', () => {
    const line =
      '{"ord":1,"id":"r","parts":[{"k":"data","data":{"a":"caf\\u00e9 \\"x\\"","n":1.50}},{"k":"data","data":{"schema":"provider_body/1"}}]}';
    expect(rawPartData(line)).toEqual(['{"a":"caf\\u00e9 \\"x\\"","n":1.50}', '{"schema":"provider_body/1"}']);
  });

  it('hashes as the Sessionizer does', () => {
    for (const text of ['', 'a', 'hello world', 'café 😀', 'x'.repeat(1000)]) {
      const bytes = new TextEncoder().encode(text);
      expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(sha256Hex(file)).toBe(createHash('sha256').update(file).digest('hex'));
  });

  it('hashes every length around a block boundary', () => {
    // the padding takes one more block only when the nine bytes it adds do not fit in the last one,
    // and a length of 55, 119, 183 … is exactly the case where they do
    for (let n = 0; n <= 260; n++) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 7 + 13) & 0xff;
      expect([n, sha256Hex(bytes)]).toEqual([n, createHash('sha256').update(bytes).digest('hex')]);
    }
  });
});
