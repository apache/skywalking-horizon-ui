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

// Starter-prompt templating. A starter string may carry `<token>` placeholders
// (e.g. "Investigate latency for <service> on <layer>"); the empty-chat UI fills
// them from a picker before sending, so the assistant gets an EXACT service name
// (a typo'd name is the #1 cause of an empty answer). A starter with no tokens
// sends verbatim, unchanged from the original behaviour. `<service>` and
// `<layer>` get real pickers; any other token falls back to a text field.

const TOKEN_RE = /<([a-zA-Z][\w-]*)>/g;

/** Distinct placeholder names in `text`, in first-seen order (e.g.
 *  ['service', 'layer']). Empty for a plain starter. */
export function starterTokens(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

/** Substitute `<token>` with values[token]; an unfilled token is left as-is so a
 *  partial fill is still recognisable rather than silently dropped. */
export function fillStarter(text: string, values: Record<string, string>): string {
  return text.replace(TOKEN_RE, (whole, name: string) => values[name] ?? whole);
}
