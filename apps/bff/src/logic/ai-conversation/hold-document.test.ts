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

import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { holdDocument, summaryFromHead } from './hold-document';

const SUMMARY = { title: 'a "quoted" title with } braces { and \\ slashes', state: 'verified', problems: ['round 2 } missing'], talks: 3, steps: 21, streams: 2, segments: 1, rounds: 1, unresolved: 0, kinds: { tool: 4 } };
const DOC = JSON.stringify({ format: 'asz.view', version: '1.0', conversation: 'c1', sessions: ['s1'], head: { round: 1, digest: 'x' }, parser: 'v1', policy: 'v1', summary: SUMMARY, rounds: [], talks: [{ kind: 'talk', children: [] }] });

describe('summaryFromHead', () => {
  it('reads the counts off the top-level summary, past a title full of braces and quotes', () => {
    expect(summaryFromHead(DOC)).toEqual({ talks: 3, steps: 21, streams: 2, segments: 1, rounds: 1, unresolved: 0 });
  });

  it('ignores a "summary" that is not a top-level key, and a head that cuts the object off', () => {
    const nested = JSON.stringify({ format: 'asz.view', head: { summary: { talks: 1 } }, title: '"summary": {' });
    expect(summaryFromHead(nested)).toBeNull();
    expect(summaryFromHead(DOC.slice(0, DOC.indexOf('"steps"')))).toBeNull();
    expect(summaryFromHead(JSON.stringify({ summary: { talks: 'three' } }))).toBeNull();
  });
});

describe('holdDocument', () => {
  it('holds a gzip body as sent, counts the decoded bytes, and reads the summary', async () => {
    const gz = gzipSync(DOC);
    const parts = [gz.subarray(0, 7), gz.subarray(7, 40), gz.subarray(40)];
    const held = await holdDocument(Readable.from(parts), 'gzip', { summary: true });
    expect(held.body.equals(gz)).toBe(true);
    expect(held.decodedBytes).toBe(Buffer.byteLength(DOC));
    expect(held.summary).toEqual({ talks: 3, steps: 21, streams: 2, segments: 1, rounds: 1, unresolved: 0 });
  });

  it('counts an identity body directly, and skips the summary when told to', async () => {
    const held = await holdDocument(Readable.from([Buffer.from(DOC)]), undefined, { summary: false });
    expect(held.decodedBytes).toBe(Buffer.byteLength(DOC));
    expect(held.summary).toBeNull();
    expect(held.body.toString('utf8')).toBe(DOC);
  });

  it('rejects a body that is not the gzip it claims to be, instead of crashing the process', async () => {
    const parts = [Buffer.from('this is not'), Buffer.from(' gzip at all, however long it goes on')];
    await expect(holdDocument(Readable.from(parts), 'gzip', { summary: true })).rejects.toThrow(/could not be decoded/);
  });

  it('holds an encoding it cannot decode without pretending to know its size', async () => {
    const held = await holdDocument(Readable.from([Buffer.from('xx')]), 'br', { summary: true });
    expect(held.decodedBytes).toBeNull();
    expect(held.summary).toBeNull();
    expect(held.body.toString()).toBe('xx');
  });
});
