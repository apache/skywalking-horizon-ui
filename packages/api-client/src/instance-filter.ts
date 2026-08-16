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
 * Instance attribute conditions — the ONE evaluator.
 *
 * Two features ask questions about an instance's attributes: a widget's
 * `visibleWhen: { kind: 'entity' }` gate, evaluated in the BFF, and an
 * extension page's `instanceAttributes`, evaluated in the browser against
 * the instance list. They share this module so "exists" cannot mean
 * present-and-non-empty on one side and merely-present on the other.
 */

/** One attribute condition on an Instance page. */
export interface InstanceAttributePredicate {
  attribute: string;
  op: 'exists' | 'eq';
  value?: string;
}

/**
 * An instance's attributes as a lookup, keyed lower-case.
 *
 * `language` is folded in as an attribute because operators think of it
 * as one. Empty values are DROPPED, which is what makes `exists` mean
 * present-and-non-empty: OAP reports an unset `namespace` / `cluster` as
 * an empty string, so keeping them would make `exists` match every
 * instance and look broken.
 */
/** How many attribute conditions one page may carry. Lives beside the
 *  evaluator so the editor that mints them and the schema that refuses a
 *  ninth read the same number. */
export const MAX_INSTANCE_ATTRIBUTE_PREDICATES = 8;

export function buildAttrMap(
  language: string | null | undefined,
  attrs: ReadonlyArray<{ name: string; value: string }>,
): Map<string, string> {
  const m = new Map<string, string>();
  if (language && language.trim()) m.set('language', language.trim());
  for (const a of attrs) {
    const v = a.value == null ? '' : String(a.value);
    if (v.trim() !== '') m.set(a.name.toLowerCase(), v);
  }
  return m;
}

/** Does one condition hold for this attribute map? `eq` compares
 *  case-insensitively, as the widget gate does. */
export function attrPredicatePass(p: InstanceAttributePredicate, attrs: Map<string, string>): boolean {
  const val = attrs.get(p.attribute.trim().toLowerCase());
  if (p.op === 'eq') return val !== undefined && val.toLowerCase() === (p.value ?? '').toLowerCase();
  return val !== undefined;
}

/** Every condition must hold. No conditions means no constraint — an
 *  empty list is not a filter that matches nothing. */
export function attrPredicatesPass(
  predicates: readonly InstanceAttributePredicate[] | undefined,
  attrs: Map<string, string>,
): boolean {
  if (!predicates || predicates.length === 0) return true;
  return predicates.every((p) => attrPredicatePass(p, attrs));
}
