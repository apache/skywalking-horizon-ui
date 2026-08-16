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
 * Matching a service name against the picker's filter box.
 *
 * Two forms, told apart by the leading and trailing slash:
 *   - `agent`      — case-insensitive substring, what the box has always done
 *   - `/^agent::/` — a regular expression
 *
 * Both run against the RAW OAP service name, including any `group::` or
 * `namespace.` prefix. The picker strips those for display, so an operator
 * typing what they see still matches; anchoring on the prefix is what lets
 * a Service page select one group without a group facet.
 */

/** Whether `filter` is written as a regex rather than a plain term. */
export function isRegexFilter(filter: string): boolean {
  const f = filter.trim();
  return f.length > 2 && f.startsWith('/') && f.endsWith('/');
}

export interface ServiceFilterMatcher {
  /** True when every name passes — an empty box filters nothing. */
  empty: boolean;
  /** A `/…/` filter that does not compile. The caller marks the box
   *  invalid; matching falls back to a literal substring so the list
   *  NARROWS rather than silently widening to everything. */
  invalid: boolean;
  match: (rawServiceName: string) => boolean;
}

export function serviceFilterMatcher(filter: string): ServiceFilterMatcher {
  const raw = filter.trim();
  if (raw.length === 0) return { empty: true, invalid: false, match: () => true };

  if (isRegexFilter(raw)) {
    const body = raw.slice(1, -1);
    try {
      const re = new RegExp(body, 'i');
      return { empty: false, invalid: false, match: (name) => re.test(name) };
    } catch {
      // Half-typed regex (`/^(unclosed/`). Treat the text literally: an
      // operator mid-keystroke should see the list shrink toward what they
      // are typing, never jump back to the full roster.
      const lower = raw.toLowerCase();
      return { empty: false, invalid: true, match: (name) => name.toLowerCase().includes(lower) };
    }
  }

  const lower = raw.toLowerCase();
  return { empty: false, invalid: false, match: (name) => name.toLowerCase().includes(lower) };
}

/** How many of `names` a filter keeps — the admin's live match count. */
export function countMatches(filter: string, names: readonly string[]): number {
  const m = serviceFilterMatcher(filter);
  if (m.empty) return names.length;
  return names.reduce((n, name) => (m.match(name) ? n + 1 : n), 0);
}
