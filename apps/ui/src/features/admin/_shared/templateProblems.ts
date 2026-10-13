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

/** One reason a template's JSON is not a usable template, as the BFF reports it. */
export interface TemplateProblem {
  /** JSON path from the ROOT of the text being displayed, e.g.
   *  `['content','components']` or `['dashboards','service',3,'expressions',0]`.
   *  Empty = the whole document. */
  path: Array<string | number>;
  message: string;
  /** Set for a JSON syntax error: character offset into the displayed text. */
  offset?: number;
}

const PLAIN_KEY = /^[A-Za-z_$][\w$-]*$/;

/**
 * A path as an operator reads it: `content.dashboards.service[3].expressions[0]`.
 * A key that is not a plain identifier (a dot, a space, a quote, empty) is
 * written `["a.b"]` so it cannot be mistaken for two steps. `rootLabel` is
 * what an empty path shows — pass it translated.
 */
export function formatProblemPath(path: ReadonlyArray<string | number>, rootLabel: string): string {
  if (path.length === 0) return rootLabel;
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (PLAIN_KEY.test(seg)) out += out ? `.${seg}` : seg;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}
