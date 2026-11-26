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
 * The line of a TAL rule file each rule is declared on. The listing gives each rule's line in the file as OAP read it,
 * and the text on screen is a read of its own, from before or after: a rule sits on the listing's line when the text
 * declares it there, else on the line the text declares it on. A rule is declared by the `name` of an item of the
 * file's top-level `rules` sequence; a `name` anywhere else — a `layerDefinitions` entry, a key inside a rule — is
 * not one.
 */

/** The scalar a `name:` line gives, as YAML reads it: quoted or plain, its comment left off; null for another line. */
function nameScalar(line: string): string | null {
  const m = /^\s*(?:-\s+)?name:\s*(.*)$/.exec(line);
  if (!m) return null;
  const raw = m[1]!.trim();
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    return end > 0 ? raw.slice(1, end) : null;
  }
  return raw.replace(/\s+#.*$/, '').trim();
}

/** The lines (1-based) of the file that declare a rule: a `name:` of an item of the top-level `rules` sequence. The
 *  sequence's dashes may sit at the key's column or be indented, with one space after them or more: the column of the
 *  first item's dash is the sequence's, and each item's keys start where its first key does. */
function ruleNameLines(lines: readonly string[]): Map<number, string> {
  const out = new Map<number, string>();
  let inRules = false;
  /** The column of the sequence's dashes, and of the current item's keys. */
  let dashIndent = -1;
  let keyIndent = -1;
  lines.forEach((line, i) => {
    if (/^\s*(#|$)/.test(line)) return;
    const dash = /^(\s*)-(?:\s+|$)/.exec(line);
    if (/^\S/.test(line) && !(inRules && dash !== null && dashIndent <= 0)) {
      // A top-level key: `rules:` opens the sequence, any other closes it.
      inRules = /^rules:\s*(#.*)?$/.test(line);
      dashIndent = -1;
      keyIndent = -1;
      return;
    }
    if (!inRules) return;
    if (dash !== null && (dashIndent === -1 || dash[1]!.length === dashIndent)) {
      dashIndent = dash[1]!.length;
      keyIndent = dash[0].length;
    } else if (/^(\s*)/.exec(line)![1]!.length !== keyIndent) {
      return;
    }
    const name = nameScalar(line);
    if (name !== null) out.set(i + 1, name);
  });
  return out;
}

/**
 * @param lines the file's text, line by line
 * @param rules the listing's rules, each with the line the listing gives it
 * @returns the rule each declaring line holds; a rule the text does not declare is left out, and two rules of one name
 *     take its declarations in order
 */
export function ruleLines<R extends { name: string; line: number }>(lines: readonly string[], rules: readonly R[]): Map<number, R> {
  const declared = ruleNameLines(lines);
  const out = new Map<number, R>();
  for (const rule of rules) {
    let at = declared.get(rule.line) === rule.name && !out.has(rule.line) ? rule.line : -1;
    if (at === -1) {
      for (const [line, name] of declared) {
        if (name === rule.name && !out.has(line)) {
          at = line;
          break;
        }
      }
    }
    if (at !== -1) out.set(at, rule);
  }
  return out;
}
