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
 * Extract metric names from raw OAL text — every statement is of the
 * form `<metric_name> = from(...).<aggregation>(...);` so the LHS of
 * the first `=` on each (non-comment) line is the metric name.
 *
 * Used by the inspect attribution layer to map metric names returned
 * by `/inspect/metrics` back to the .oal file that declared them.
 *
 * The parser handles line comments (`//`) and block comments (`/* … *\/`).
 * It does not need to fully tokenise OAL — only LHS-before-equals
 * matters; the RHS can be arbitrarily complex.
 */

const METRIC_NAME_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Strip C-style line and block comments from a source string. */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock.replace(/\/\/[^\n]*/g, '');
}

/** Extract every metric name (LHS of `=`) from a `.oal` file body.
 *  Returns deduplicated metric names in declaration order. */
export function parseOalMetricNames(content: string): string[] {
  const cleaned = stripComments(content);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of cleaned.split('\n')) {
    const m = METRIC_NAME_RE.exec(line);
    if (!m) continue;
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
