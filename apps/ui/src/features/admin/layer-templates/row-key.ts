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
 * Stable per-object key for `v-for` over editable, reorderable/deletable draft
 * lists (metric definitions, service-list columns, role/pair cards). An index
 * key lets Vue reuse a row's DOM across a splice/swap, glitching input focus and
 * selection on the row being edited; the rows' own id / metric / key fields are
 * operator-mutable (and non-unique mid-edit) so they can't serve as keys either.
 * A WeakMap stamps a stable id per object identity — never serialized, survives
 * reorder, and is released for GC when the object is dropped from the draft.
 */
let seq = 0;
const ids = new WeakMap<object, number>();

export function rowKey(obj: object): number {
  let id = ids.get(obj);
  if (id === undefined) {
    id = (seq += 1);
    ids.set(obj, id);
  }
  return id;
}
