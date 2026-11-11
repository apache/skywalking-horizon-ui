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

/** What Zipkin's `annotationQuery` splits its terms on — and so what joins them. */
export const ANNOTATION_TERM_SEPARATOR = ' and ';

/**
 * The terms of one entry in the Zipkin annotation field, or null when any of
 * them is malformed. A term is a bare annotation (`error`) or a `key=value`
 * tag; Zipkin reads `key=` as the bare `key`, so a side left empty is refused
 * rather than silently meaning something else. Several terms typed at once
 * with ` and ` come back separately, split as Zipkin splits them.
 */
export function parseAnnotationTerms(raw: string): string[] | null {
  const terms = raw.split(ANNOTATION_TERM_SEPARATOR).map((s) => s.trim());
  if (terms.some((s) => !s)) return null;
  const out: string[] = [];
  for (const term of terms) {
    const idx = term.indexOf('=');
    if (idx === -1) {
      out.push(term);
      continue;
    }
    const key = term.slice(0, idx).trim();
    const value = term.slice(idx + 1).trim();
    if (!key || !value) return null;
    out.push(`${key}=${value}`);
  }
  return out;
}
