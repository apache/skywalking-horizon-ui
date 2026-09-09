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
 * A line diff of two texts, for drawing an edit the way git shows it: the
 * lines both have as context, the ones only the first has as removed, the
 * ones only the second has as added. A longest-common-subsequence over
 * lines, bounded: past the cap the two texts are shown whole, removed then
 * added, rather than compared.
 */

export interface DiffRow {
  kind: 'ctx' | 'add' | 'del';
  text: string;
}

export const LINE_DIFF_CAP = 400;

export function lineDiff(before: string, after: string): DiffRow[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const del = (text: string): DiffRow => ({ kind: 'del', text });
  const add = (text: string): DiffRow => ({ kind: 'add', text });
  if (a.length > LINE_DIFF_CAP || b.length > LINE_DIFF_CAP) return [...a.map(del), ...b.map(add)];
  const n = a.length;
  const m = b.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'ctx', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push(del(a[i]!));
      i++;
    } else {
      rows.push(add(b[j]!));
      j++;
    }
  }
  while (i < n) rows.push(del(a[i++]!));
  while (j < m) rows.push(add(b[j++]!));
  return rows;
}
