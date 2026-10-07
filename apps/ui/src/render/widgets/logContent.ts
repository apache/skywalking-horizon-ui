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

import type { LogRow } from '@/api/client';

/** How a log row's content is shown, shared by the log stream and its detail
 *  popout so a row reads the same in both. */
export type LogFormat = 'json' | 'yaml' | 'text';

export function detectFormat(r: LogRow): LogFormat {
  if (r.contentType === 'application/json') return 'json';
  const trimmed = r.content?.trim() ?? '';
  if (!trimmed) return 'text';
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { JSON.parse(trimmed); return 'json'; } catch { /* fallthrough */ }
  }
  if (trimmed.startsWith('---') || trimmed.startsWith('apiVersion:')) return 'yaml';
  const lines = trimmed.split('\n');
  if (lines.length >= 2) {
    const topLevelMaps = lines.filter((l) => /^[A-Za-z_][\w.-]*\s*:\s*(\S|$)/.test(l)).length;
    if (topLevelMaps >= 2) return 'yaml';
  }
  return 'text';
}

function compactJson(r: LogRow): string | null {
  try { return JSON.stringify(JSON.parse(r.content)); } catch { return null; }
}

/** Single-line preview. JSON re-serialises tight; YAML / text collapse
 *  whitespace so the row stays one line. */
export function previewContent(r: LogRow): string {
  if (!r.content) return '';
  const fmt = detectFormat(r);
  if (fmt === 'json') {
    const json = compactJson(r);
    if (json !== null) return json;
  }
  if (fmt === 'yaml') return r.content.replace(/\n+/g, ' ').trim();
  return r.content.replace(/\s+/g, ' ').trim();
}

/** The whole payload: JSON indented, YAML / text verbatim. */
export function prettyContent(r: LogRow): string {
  if (detectFormat(r) === 'json') {
    try { return JSON.stringify(JSON.parse(r.content), null, 2); } catch { /* fall through */ }
  }
  return r.content;
}
