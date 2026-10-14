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
 * A role pair's `primary` names metric ids of that pair, and the push refuses
 * the whole layer over one that names no metric. So a metric renamed or
 * removed in the editor carries into `primary` (a string for one id, a list
 * for two or three; absent for none).
 */

import type { RolePairMetrics } from '@skywalking-horizon-ui/api-client';

function ids(p: RolePairMetrics): string[] {
  if (Array.isArray(p.primary)) return [...p.primary];
  return p.primary ? [p.primary] : [];
}

function store(p: RolePairMetrics, next: string[]): void {
  if (next.length === 0) delete p.primary;
  else p.primary = next.length === 1 ? next[0]! : next;
}

export function renameInPrimary(p: RolePairMetrics, from: string, to: string): void {
  if (!to) return;
  const current = ids(p);
  if (!current.includes(from)) return;
  // Renamed onto an id already listed, it would print the same value twice.
  store(p, [...new Set(current.map((id) => (id === from ? to : id)))]);
}

export function dropFromPrimary(p: RolePairMetrics, id: string): void {
  const current = ids(p);
  if (!current.includes(id)) return;
  store(p, current.filter((x) => x !== id));
}
