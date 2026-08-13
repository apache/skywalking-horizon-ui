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
 * Why a push was refused, as lines to show the operator.
 *
 * The BFF answers an unpublishable template with `400 { code:
 * 'invalid_content', issues: [...] }`, and the issue list is the whole message
 * — which field, and the name to publish it under when the row itself is the
 * problem. The transport error's own `message` is only `POST … failed (400)`,
 * so a page that renders that instead tells the operator nothing. Not
 * translated: these name JSON paths and template names, same as the BFF's other
 * structural errors.
 */
export function pushErrorLines(err: unknown): string[] {
  const e = err as { body?: { issues?: unknown }; message?: unknown };
  const issues = e?.body?.issues;
  // Emptiness is judged AFTER the filter: a non-empty `issues` carrying no
  // strings would otherwise return [], and every caller joins the result — so
  // the operator would get a blank message instead of the transport error.
  const lines = Array.isArray(issues)
    ? issues.filter((i): i is string => typeof i === 'string')
    : [];
  if (lines.length > 0) return lines;
  return [typeof e?.message === 'string' ? e.message : String(err)];
}
