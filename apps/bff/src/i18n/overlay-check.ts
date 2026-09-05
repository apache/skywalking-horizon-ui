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
 * The rule for what a per-locale overlay may say about its source template:
 * only the allowlisted text fields, addressed the way the runtime merger
 * addresses them.
 *
 * Split out of `validate.ts` because both the CLI and the SAVE path need it,
 * and the CLI must not be on the server's import graph — it decides whether
 * to run itself by comparing `import.meta.url` against `process.argv[1]`,
 * which the packager makes true by bundling it into the entrypoint. Nothing
 * here touches the filesystem or the process.
 */

import { idAddressableIds } from '@skywalking-horizon-ui/api-client';

export interface Finding {
  file: string;
  path: string;
  message: string;
}

const STRING_FIELDS = new Set(['alias', 'title', 'description', 'tip', 'label', 'group', 'name']);
const STRING_VALUE_OBJECTS = new Set(['aliases', 'slots', 'valueMap']);
const STRING_ARRAYS = new Set(['expressionLabels', 'tableHeaders']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Check an overlay array against an id-addressable source array — every
 * source entry carries a unique `id`, so the overlay is expected to
 * address entries by that id rather than by position.
 *
 * A legacy overlay carrying no ids at all still renders (the merger
 * falls back to position) but is reported: it cannot survive a widget
 * reorder, and the bundled catalogs are migrated.
 */
function walkIdArray(
  source: readonly unknown[],
  ids: readonly string[],
  overlay: readonly unknown[],
  path: string[],
  findings: Finding[],
  file: string,
): void {
  const known = new Map(ids.map((id, i) => [id, i]));
  const seen = new Set<string>();
  let idKeyed = false;
  let positional = false;
  if (overlay.length > source.length) {
    findings.push({
      file,
      path: path.join('.'),
      message: `overlay has ${overlay.length} entries for ${source.length} source entries`,
    });
  }
  for (let i = 0; i < overlay.length; i++) {
    const entry = overlay[i];
    if (entry === null || entry === undefined) continue;
    const at = [...path, String(i)].join('.');
    if (!isObject(entry)) {
      findings.push({ file, path: at, message: 'overlay entry should be an object' });
      continue;
    }
    const id = entry.id;
    if (id === undefined) {
      positional = true;
      if (i < source.length) walk(source[i], entry, [...path, String(i)], findings, file);
      continue;
    }
    if (typeof id !== 'string' || id.length === 0) {
      findings.push({ file, path: `${at}.id`, message: 'overlay "id" should be a non-empty string' });
      continue;
    }
    idKeyed = true;
    if (!known.has(id)) {
      findings.push({ file, path: at, message: `no source entry with id "${id}"` });
      continue;
    }
    if (seen.has(id)) {
      findings.push({ file, path: at, message: `duplicate overlay entry for id "${id}"` });
      continue;
    }
    seen.add(id);
    walk(source[known.get(id) as number], entry, [...path, String(i)], findings, file, true);
  }
  if (idKeyed && positional) {
    findings.push({
      file,
      path: path.join('.'),
      message: 'overlay mixes id-addressed and positional entries — the positional ones are dropped at render',
    });
    return;
  }
  if (!idKeyed && positional) {
    findings.push({
      file,
      path: path.join('.'),
      message:
        'overlay entries carry no "id" — source entries have stable ids, so add them; a positional overlay cannot follow a reordered entry',
    });
  }
}

export function walk(
  source: unknown,
  overlay: unknown,
  path: string[],
  findings: Finding[],
  file: string,
  idIsStructural = false,
): void {
  if (overlay === null || overlay === undefined) return;
  if (Array.isArray(source)) {
    if (!Array.isArray(overlay)) {
      findings.push({ file, path: path.join('.'), message: 'overlay should be an array' });
      return;
    }
    const ids = idAddressableIds(source);
    if (ids) {
      walkIdArray(source, ids, overlay, path, findings, file);
      return;
    }
    for (let i = 0; i < overlay.length; i++) {
      if (isObject(overlay[i]) && 'id' in (overlay[i] as Record<string, unknown>)) {
        findings.push({
          file,
          path: [...path, String(i)].join('.'),
          message:
            'overlay entry carries an "id" but the source array is not id-addressable (entries lack a unique id) — this array matches by position',
        });
      }
      if (i >= source.length) {
        findings.push({
          file,
          path: [...path, String(i)].join('.'),
          message: 'overlay index beyond source array length',
        });
        continue;
      }
      walk(source[i], overlay[i], [...path, String(i)], findings, file);
    }
    return;
  }
  if (source !== null && typeof source === 'object') {
    if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) {
      findings.push({ file, path: path.join('.'), message: 'overlay should be an object' });
      return;
    }
    const src = source as Record<string, unknown>;
    const ovl = overlay as Record<string, unknown>;
    for (const [k, v] of Object.entries(ovl)) {
      if (!(k in src)) {
        findings.push({
          file,
          path: [...path, k].join('.'),
          message: 'no matching key in source template',
        });
        continue;
      }
      const sv = src[k];
      if (STRING_FIELDS.has(k)) {
        if (typeof sv !== 'string') {
          findings.push({
            file,
            path: [...path, k].join('.'),
            message: 'source value is not a string; field is not translatable',
          });
        } else if (typeof v !== 'string') {
          findings.push({
            file,
            path: [...path, k].join('.'),
            message: 'overlay value should be a string',
          });
        }
        continue;
      }
      if (STRING_VALUE_OBJECTS.has(k)) {
        if (!sv || typeof sv !== 'object' || Array.isArray(sv)) {
          findings.push({
            file,
            path: [...path, k].join('.'),
            message: 'source value is not an object; field shape mismatch',
          });
          continue;
        }
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          findings.push({
            file,
            path: [...path, k].join('.'),
            message: 'overlay value should be an object of string-keyed strings',
          });
          continue;
        }
        const srcInner = sv as Record<string, unknown>;
        for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
          if (!(ik in srcInner)) {
            findings.push({
              file,
              path: [...path, k, ik].join('.'),
              message: 'no matching key in source object',
            });
          } else if (typeof iv !== 'string') {
            findings.push({
              file,
              path: [...path, k, ik].join('.'),
              message: 'overlay value should be a string',
            });
          }
        }
        continue;
      }
      if (STRING_ARRAYS.has(k)) {
        if (!Array.isArray(sv)) {
          findings.push({
            file,
            path: [...path, k].join('.'),
            message: 'source value is not an array',
          });
          continue;
        }
        if (!Array.isArray(v)) {
          findings.push({
            file,
            path: [...path, k].join('.'),
            message: 'overlay value should be an array',
          });
          continue;
        }
        for (let i = 0; i < v.length; i++) {
          if (i >= sv.length) {
            findings.push({
              file,
              path: [...path, k, String(i)].join('.'),
              message: 'overlay index beyond source array length',
            });
            continue;
          }
          if (v[i] !== null && typeof v[i] !== 'string') {
            findings.push({
              file,
              path: [...path, k, String(i)].join('.'),
              message: 'overlay value should be a string or null',
            });
          }
        }
        continue;
      }
      // `id` on an entry of an id-addressable array is the structural
      // matching key — walkIdArray has already checked it. Anywhere
      // else an overlay `id` is just a non-translatable field, and
      // falls through to the allowlist finding below.
      if (k === 'id' && idIsStructural) continue;
      // Non-allowlisted key: recurse if both sides are containers,
      // otherwise (leaf-level non-translatable key in overlay) flag.
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        findings.push({
          file,
          path: [...path, k].join('.'),
          message: `field "${k}" is not in the translatable allowlist`,
        });
        continue;
      }
      walk(sv, v, [...path, k], findings, file);
    }
    return;
  }
  // A primitive source reached by recursion. Every allowlisted field is
  // consumed in the object branch above and never recurses, so anything
  // arriving here sits at a path the overlay may not set — most importantly
  // the string elements of a non-allowlisted array (`expressions`), which
  // the runtime merger replaces exactly like any other string leaf.
  findings.push({
    file,
    path: path.join('.'),
    message: `"${path[path.length - 1] ?? '(root)'}" is not in the translatable allowlist`,
  });
}

/** Mirror the layer loader's `aliases → slots` migration so validate
 *  walks against the normalised tree (same shape the runtime merger
 *  sees). Otherwise overlays correctly written against the canonical
 *  `slots` shape would be flagged as orphans against the raw source
 *  file's `aliases` key. Keep in sync with `seed.ts:normaliseSource`. */
export function normaliseSource(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const rec = raw as Record<string, unknown>;
  if (rec.aliases && !rec.slots) {
    const { aliases, ...rest } = rec;
    return { ...rest, slots: aliases };
  }
  return rec;
}

/**
 * Check one overlay against the live source it overlays, with the same
 * allowlist the bundled catalogs are held to.
 *
 * This is the WRITE boundary for `translation:write`, not a lint: the runtime
 * merger replaces any string leaf the overlay sets at a matching path, so
 * without it an overlay could rewrite a layer key, a widget type or an MQE
 * expression — structure and queries, under a permission that means wording.
 */
export function overlayFindings(source: unknown, overlay: unknown): Finding[] {
  const findings: Finding[] = [];
  walk(normaliseSource(source), overlay, [], findings, '<overlay>');
  return findings;
}
