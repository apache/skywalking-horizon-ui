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

import type { LayerDef } from '@skywalking-horizon-ui/api-client';

interface LayerGroup { kind: 'group'; label: string; layers: LayerDef[] }
interface LayerSingle { kind: 'single'; layer: LayerDef }
export type SidebarEntry = LayerGroup | LayerSingle;

/** Group visible public layers at their first member's position. A group
 * with only one visible member renders as a standalone layer instead. */
export function buildSidebarEntries(rows: readonly LayerDef[]): SidebarEntry[] {
  const out: SidebarEntry[] = [];
  const groupBuckets = new Map<string, LayerDef[]>();
  for (const L of rows) {
    if (L.group) {
      if (!groupBuckets.has(L.group)) {
        groupBuckets.set(L.group, []);
        out.push({ kind: 'group', label: L.group, layers: groupBuckets.get(L.group)! });
      }
      groupBuckets.get(L.group)!.push(L);
    } else {
      out.push({ kind: 'single', layer: L });
    }
  }
  return out.map((entry) =>
    entry.kind === 'group' && entry.layers.length === 1
      ? { kind: 'single', layer: entry.layers[0]! }
      : entry,
  );
}
