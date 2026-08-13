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
 * Mint the next `<prefix><n>` that nothing in `taken` holds, counting from 1.
 *
 * Every editable list on the layer-template editors — service-list columns,
 * widgets, deployment metrics and roles, topology / process / dependency metric
 * rows — seeds a new row's id from the list LENGTH, which re-mints a live id
 * after any add / delete / add sequence. Depending on the list, the collision is
 * refused at publish (duplicate column metric, duplicate widget id) or silently
 * aliases two rows onto one value at render. Route every "add a row" path here.
 */
export function nextFreeId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n += 1) {
    const candidate = `${prefix}${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
