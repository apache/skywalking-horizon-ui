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
 * Translatable-field walker — mirrors the BFF's seed allowlist in
 * `apps/bff/src/i18n/seed.ts`. Walks an English source template and
 * yields one entry per translatable leaf. The editor displays this
 * list as the EN-source / target-input table; the overlay applier
 * pokes new values back along the same path.
 */

const STRING_FIELDS = new Set(['alias', 'title', 'description', 'tip', 'label', 'group']);
const STRING_VALUE_OBJECTS = new Set(['aliases', 'slots']);
const STRING_ARRAYS = new Set(['expressionLabels', 'tableHeaders']);

/** Paths under which the `alias` field is a regex-replacement
 *  template (e.g. `$1`, `$<service>`), NOT a translatable label.
 *  Operators editing translations should not see these — they would
 *  type a Chinese / Spanish / etc. replacement that would silently
 *  break service-name parsing at render time. */
const EXCLUDE_PATH_PREFIXES = ['naming'];

export interface TranslatableField {
  /** Dot/bracket path from the source root, e.g. `overview.groups[0].title`. */
  path: string;
  /** Path as an array of segments (numbers = array index). Suitable for
   *  `setByPath` on a fresh overlay object. */
  segments: Array<string | number>;
  /** The English value at this path. */
  source: string;
  /** Section label for the editor's UI group (e.g. `overview`, `dashboards.service`). */
  section: string;
}

/**
 * Enumerate every translatable string leaf in `source`, in document
 * order. Returns a flat list — the editor groups by `section`.
 *
 * Section is the path prefix without the array index — readable
 * grouping that's stable across re-renders ("overview > groups >
 * metrics" rather than "overview.groups[1].metrics[0]").
 */
export function walkTranslatable(source: unknown): TranslatableField[] {
  const out: TranslatableField[] = [];
  walk(source, [], '', out);
  return out.filter((f) => !EXCLUDE_PATH_PREFIXES.some((p) => f.path === p || f.path.startsWith(`${p}.`) || f.path.startsWith(`${p}[`)));
}

function walk(node: unknown, segments: Array<string | number>, section: string, out: TranslatableField[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, [...segments, i], section, out));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) {
    const segNext = [...segments, k];
    if (STRING_FIELDS.has(k) && typeof v === 'string' && v.length > 0) {
      out.push({
        path: pathString(segNext),
        segments: segNext,
        source: v,
        section: section || 'root',
      });
      continue;
    }
    if (STRING_VALUE_OBJECTS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof iv !== 'string' || iv.length === 0) continue;
        const segs = [...segNext, ik];
        out.push({
          path: pathString(segs),
          segments: segs,
          source: iv,
          section: section ? `${section} › ${k}` : k,
        });
      }
      continue;
    }
    if (STRING_ARRAYS.has(k) && Array.isArray(v)) {
      v.forEach((entry, i) => {
        if (typeof entry !== 'string' || entry.length === 0) return;
        const segs = [...segNext, i];
        out.push({
          path: pathString(segs),
          segments: segs,
          source: entry,
          section: section ? `${section} › ${k}` : k,
        });
      });
      continue;
    }
    if (v && typeof v === 'object') {
      const nextSection = sectionLabel(section, k);
      walk(v, segNext, nextSection, out);
    }
  }
}

function pathString(segments: Array<string | number>): string {
  return segments
    .map((s, i) => (typeof s === 'number' ? `[${s}]` : i === 0 ? s : `.${s}`))
    .join('');
}

function sectionLabel(parent: string, key: string): string {
  if (!parent) return key;
  return `${parent} › ${key}`;
}

/**
 * Read the value at `segments` from `obj`, or `undefined` if any
 * segment is missing or not the right shape.
 */
export function getAtPath(obj: unknown, segments: Array<string | number>): string | undefined {
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return typeof cur === 'string' ? cur : undefined;
}

/**
 * Set `value` at `segments` in `obj`, creating intermediate objects /
 * sparse arrays as needed. Used to build the per-locale overlay from
 * the editor's flat input list. Mutates `obj`.
 */
export function setAtPath(obj: Record<string, unknown> | unknown[], segments: Array<string | number>, value: string): void {
  let cur: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = segments[i + 1];
    const arrAhead = typeof next === 'number';
    if (typeof seg === 'number') {
      const arr = cur as unknown[];
      if (arr[seg] === undefined || arr[seg] === null) {
        arr[seg] = arrAhead ? [] : {};
      }
      cur = arr[seg] as Record<string, unknown> | unknown[];
    } else {
      const rec = cur as Record<string, unknown>;
      if (rec[seg] === undefined || rec[seg] === null) {
        rec[seg] = arrAhead ? [] : {};
      }
      cur = rec[seg] as Record<string, unknown> | unknown[];
    }
  }
  const last = segments[segments.length - 1];
  if (typeof last === 'number') {
    (cur as unknown[])[last] = value;
  } else {
    (cur as Record<string, unknown>)[last] = value;
  }
}
