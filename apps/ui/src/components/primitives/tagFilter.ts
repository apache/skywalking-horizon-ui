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
 * Suggestions a host already holds for {@link TagInput} — Zipkin's
 * autocomplete keys, a TraceQL store's span attributes. `valuesFor` is read
 * inside the field's own computed, so it must read reactive state for a late
 * answer to reach the list.
 */
export interface TagSuggestions {
  keys: readonly string[];
  valuesFor: (key: string) => readonly string[];
  loadValues: (key: string) => void;
}

/** A typed `key=value` tag, or null when either side is missing. Splits at the
 *  first `=`, so a value may itself hold one. `exactValue` keeps the value's
 *  own leading and trailing spaces, for a host that compares it verbatim. */
export function parseTagPair(raw: string, opts: { exactValue?: boolean } = {}): { key: string; value: string } | null {
  const idx = raw.indexOf('=');
  if (idx === -1) return null;
  const key = raw.slice(0, idx).trim();
  const rest = raw.slice(idx + 1);
  const value = opts.exactValue ? rest : rest.trim();
  return key && value.trim() ? { key, value } : null;
}
