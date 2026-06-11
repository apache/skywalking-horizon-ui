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

import { describe, it, expect, beforeAll } from 'vitest';
import { transform } from 'esbuild';
import { TraceMap } from '@jridgewell/trace-mapping';
import { parseFrames, resolveFrame, resolveStack } from './resolve.js';

// Original source — one meaningful token per line so a resolved position
// maps to an unambiguous original line. "HELLO_MARKER" is unique so we can
// find its column in the minified output.
const SOURCE = [
  'function greet(name) {', //                         line 1
  '  const greeting = "HELLO_MARKER";', //              line 2
  '  return greeting + name;', //                       line 3
  '}', //                                               line 4
  'globalThis.__greet = greet;', //                     line 5
].join('\n');

let map: TraceMap;
let minified: string;
let markerCol0: number; // 0-based column of the marker in the minified line

beforeAll(async () => {
  // A REAL toolchain-emitted Source Map v3 — esbuild is the build tool, so
  // this proves the resolver against an authentic map, not a hand fixture.
  const out = await transform(SOURCE, {
    loader: 'js',
    sourcemap: true,
    minify: true,
    sourcesContent: true,
    sourcefile: 'greet.js',
  });
  minified = out.code;
  map = new TraceMap(out.map);
  markerCol0 = minified.indexOf('HELLO_MARKER');
  expect(markerCol0).toBeGreaterThanOrEqual(0);
});

describe('resolveFrame — real esbuild map', () => {
  it('maps a minified position back to the original source line', () => {
    // Frames carry 1-based columns (browser convention); resolveFrame
    // shifts to the 0-based column the map indexes.
    const frame = { file: 'greet.js', line: 1, col: markerCol0 + 1, fn: 'greet' };
    const resolved = resolveFrame(map, frame);
    expect(resolved.original).not.toBeNull();
    expect(resolved.original?.source).toBe('greet.js');
    expect(resolved.original?.line).toBe(2);
  });

  it('includes a source snippet around the mapped line (sourcesContent)', () => {
    const resolved = resolveFrame(map, { file: 'greet.js', line: 1, col: markerCol0 + 1, fn: null });
    expect(resolved.snippet).toBeTruthy();
    expect(resolved.snippet?.lines.join('\n')).toContain('HELLO_MARKER');
  });

  it('returns original=null for a position outside the map', () => {
    const resolved = resolveFrame(map, { file: 'greet.js', line: 999_999, col: 1, fn: null });
    expect(resolved.original).toBeNull();
  });

  it('returns original=null when the frame has no line', () => {
    expect(resolveFrame(map, { file: 'x', line: null, col: null, fn: null }).original).toBeNull();
  });
});

describe('parseFrames — engine-specific stack formats', () => {
  const URL = 'https://app.example.com/assets/main.abc123.js';

  it('parses a V8 / Chrome stack', () => {
    const stack = [
      'Error: boom',
      `    at greet (${URL}:1:845)`,
      `    at ${URL}:1:870`,
    ].join('\n');
    const frames = parseFrames(stack);
    expect(frames.length).toBe(2);
    expect(frames[0]).toMatchObject({ file: URL, line: 1, col: 845, fn: 'greet' });
    expect(frames[1]).toMatchObject({ file: URL, line: 1, col: 870 });
  });

  it('parses a Firefox / Gecko stack', () => {
    const stack = [`greet@${URL}:1:845`, `@${URL}:1:870`].join('\n');
    const frames = parseFrames(stack);
    expect(frames.length).toBe(2);
    expect(frames[0]).toMatchObject({ file: URL, line: 1, col: 845 });
  });

  it('parses a Safari / JSC stack', () => {
    const stack = [`greet@${URL}:1:845`, `global code@${URL}:1:870`].join('\n');
    const frames = parseFrames(stack);
    expect(frames.length).toBe(2);
    expect(frames[0].file).toBe(URL);
    expect(frames[0].line).toBe(1);
  });

  it('returns [] for empty / garbage input', () => {
    expect(parseFrames(undefined)).toEqual([]);
    expect(parseFrames('')).toEqual([]);
    expect(parseFrames('not a stack trace at all')).toEqual([]);
  });
});

describe('resolveStack — full pipeline', () => {
  it('resolves frames parsed from a V8 stack against the map', () => {
    const stack = `Error: boom\n    at greet (main.js:1:${markerCol0 + 1})`;
    const frames = resolveStack(map, { stack });
    expect(frames.length).toBe(1);
    expect(frames[0].original?.line).toBe(2);
    expect(frames[0].original?.source).toBe('greet.js');
  });

  it('falls back to the top-level line/col when the stack has no frames (JS category)', () => {
    const frames = resolveStack(map, { stack: null, line: 1, col: markerCol0 + 1, errorUrl: 'main.js' });
    expect(frames.length).toBe(1);
    expect(frames[0].original?.line).toBe(2);
  });

  it('returns [] when there is neither a parseable stack nor a top-level line', () => {
    expect(resolveStack(map, { stack: 'garbage', line: null })).toEqual([]);
  });
});
