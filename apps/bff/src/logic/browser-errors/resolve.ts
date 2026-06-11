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
 * Pure source-map resolution: minified `(file,line,col)` → original
 * `(source,line,col,name)` + a source snippet. No IO, no store — takes a
 * parsed `TraceMap` and the error's stack/position, returns frames. This
 * is the piece that gets fixture-tested with a real esbuild-emitted map.
 *
 * The hard part is NOT the mapping — it's that the browser agent ships a
 * raw `error.stack` STRING whose format is engine-specific (V8 / Gecko /
 * JSC). We lean on `stacktrace-parser` to normalise those into frames,
 * then map each frame. When there are no parseable frames we fall back to
 * the top-level `line`/`col` (only the `JS` category populates those).
 */

import { originalPositionFor, sourceContentFor, type TraceMap } from '@jridgewell/trace-mapping';
import { parse as parseStackTrace } from 'stacktrace-parser';
import type { ResolvedFrame } from '@skywalking-horizon-ui/api-client';

/** A minified frame, columns as they appear in the wire (1-based). */
export interface GeneratedFrame {
  file: string | null;
  line: number | null;
  col: number | null;
  fn: string | null;
}

export interface ResolveInput {
  stack?: string | null;
  line?: number | null;
  col?: number | null;
  errorUrl?: string | null;
}

/** Lines of original source kept on each side of the mapped line. */
const SNIPPET_RADIUS = 2;

/** Split a raw `error.stack` into frames. Returns [] for empty/garbage
 *  input — never throws to the caller. */
export function parseFrames(stack: string | null | undefined): GeneratedFrame[] {
  if (!stack) return [];
  try {
    return parseStackTrace(stack).map((f) => ({
      file: f.file ?? null,
      line: f.lineNumber ?? null,
      col: f.column ?? null,
      fn: f.methodName ?? null,
    }));
  } catch {
    return [];
  }
}

function snippetFor(
  map: TraceMap,
  source: string | null,
  line: number | null,
): ResolvedFrame['snippet'] {
  if (!source || line == null || line < 1) return null;
  const content = sourceContentFor(map, source);
  if (!content) return null;
  const all = content.split('\n');
  const start = Math.max(1, line - SNIPPET_RADIUS);
  const end = Math.min(all.length, line + SNIPPET_RADIUS);
  if (start > all.length) return null;
  return { startLine: start, lines: all.slice(start - 1, end) };
}

/** Map one generated frame to its original position. `original` is null
 *  when the frame has no line or falls outside the map. */
export function resolveFrame(map: TraceMap, frame: GeneratedFrame): ResolvedFrame {
  if (frame.line == null) return { generated: frame, original: null };
  // Source maps index columns 0-based; browser stack traces (V8) and the
  // `window.onerror` `colno` are 1-based. Shift before the lookup or every
  // result lands one column early.
  const column = frame.col != null && frame.col > 0 ? frame.col - 1 : 0;
  const pos = originalPositionFor(map, { line: frame.line, column });
  if (pos.source == null) return { generated: frame, original: null };
  return {
    generated: frame,
    original: {
      source: pos.source,
      line: pos.line ?? null,
      col: pos.column ?? null,
      name: pos.name ?? null,
    },
    snippet: snippetFor(map, pos.source, pos.line ?? null),
  };
}

/** Resolve a whole error: prefer the parsed stack frames; fall back to the
 *  single top-level position when the stack yields nothing. */
export function resolveStack(map: TraceMap, input: ResolveInput): ResolvedFrame[] {
  const frames = parseFrames(input.stack);
  if (frames.length > 0) return frames.map((f) => resolveFrame(map, f));
  if (input.line != null) {
    return [
      resolveFrame(map, {
        file: input.errorUrl ?? null,
        line: input.line,
        col: input.col ?? null,
        fn: null,
      }),
    ];
  }
  return [];
}
