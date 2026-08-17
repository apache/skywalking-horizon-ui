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
 * What a stored `menuOrder` may contain, as two decisions the editor makes
 * every time the menu changes shape.
 *
 * Extracted so the tests exercise these rules rather than a copy of them:
 * a test that re-implements the pruning passes while the editor does
 * something else, which is the failure mode worth designing against.
 */

/** Keep only entries the layer still resolves. A stored order naming a
 *  row that no longer exists is refused at publish, while the editor stops
 *  drawing it — the draft looks right and the push fails. */
export function pruneMenuOrder(order: readonly string[], livePaths: readonly string[]): string[] {
  const live = new Set(livePaths);
  return order.filter((p) => live.has(p));
}

/** True when an arrangement says exactly what absence already says.
 *  Storing it would be a pending change against OAP that moves no menu. */
export function isBuiltInOrder(paths: readonly string[], builtIn: readonly string[]): boolean {
  return paths.length === builtIn.length && paths.every((p, i) => p === builtIn[i]);
}
