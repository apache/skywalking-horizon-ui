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
import { LINE_DIFF_CAP, lineDiff } from '../src/view/linediff.js';

describe('lineDiff', () => {
  it('keeps common lines as context and marks the rest removed or added', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'ctx', text: 'c' },
      { kind: 'add', text: 'd' },
    ]);
  });

  it('shows one-line edits as a removed and an added line', () => {
    expect(lineDiff('var timeout = 30', 'var timeoutSeconds = 30')).toEqual([
      { kind: 'del', text: 'var timeout = 30' },
      { kind: 'add', text: 'var timeoutSeconds = 30' },
    ]);
  });

  it('shows the texts whole rather than comparing them past the cap', () => {
    const big = Array.from({ length: LINE_DIFF_CAP + 1 }, (_, i) => `l${i}`).join('\n');
    const rows = lineDiff(big, 'l0');
    expect(rows.filter((r) => r.kind === 'ctx')).toHaveLength(0);
    expect(rows.at(-1)).toEqual({ kind: 'add', text: 'l0' });
  });
});
