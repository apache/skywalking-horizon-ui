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
 * Structural deep-merge of a translation overlay onto an English source
 * template. The overlay mirrors the source's tree shape; at each leaf
 * the overlay's non-empty string wins, otherwise the source value falls
 * through.
 *
 * Three properties matter:
 *   1. **Source-shape preservation.** The output is structurally
 *      identical to the source: array lengths, key sets, value types
 *      all unchanged. The merger never inserts or removes keys. The UI
 *      can render the localized template through the exact same code
 *      path as the English source.
 *   2. **Drift-safe.** Overlay keys that don't exist in the source are
 *      silently ignored. Overlay values whose type doesn't match the
 *      source's are silently ignored. This means a stale catalog (left
 *      over after a source rename) never breaks rendering — at worst
 *      the user sees English.
 *   3. **Leaf fallback to English.** Missing or empty string entries in
 *      the overlay fall through to the source. Half-translated
 *      catalogs are a valid and common state — they ship strictly
 *      better UX than English-only.
 *
 * Non-string leaves (numbers, booleans, null) are passed through
 * unchanged. The overlay's job is text only.
 */

export function mergeLocalizedNode(source: unknown, overlay: unknown): unknown {
  if (Array.isArray(source)) {
    if (!Array.isArray(overlay)) return source;
    // Source decides array length; overlay entries at indices beyond
    // the source are ignored. Sparse overlay entries (undefined /
    // missing index) are handled by recursing into mergeLocalizedNode,
    // which falls through to the source.
    return source.map((item, i) => mergeLocalizedNode(item, overlay[i]));
  }
  if (source !== null && typeof source === 'object') {
    if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return source;
    const ovl = overlay as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
      out[k] = mergeLocalizedNode(v, ovl[k]);
    }
    return out;
  }
  if (typeof source === 'string') {
    if (typeof overlay === 'string' && overlay.length > 0) return overlay;
    return source;
  }
  return source;
}

/**
 * Generic localize: returns the source unchanged for English or when no
 * overlay exists; otherwise returns a deep-merged copy.
 *
 * The returned object is structurally a fresh tree — callers can mutate
 * it without bleeding back into the cached source. The English path is
 * a reference-equality return; callers should treat it as read-only
 * (every caller in the codebase does today).
 */
export function localize<T>(source: T, overlay: unknown, locale: string): T {
  if (locale === 'en' || overlay === null || overlay === undefined) return source;
  return mergeLocalizedNode(source, overlay) as T;
}

/**
 * Localize a layer / overview template against its **OAP** translation
 * overlay row (`horizon.<kind>.<key>.i18n.<locale>`), most-specific-wins
 * per leaf: the OAP overlay value, else the English source.
 *
 * Runtime is REMOTE-only. The disk `*.i18n.<lang>.json` files are
 * seed/reset defaults — boot-seed pushes each as a sibling OAP overlay
 * row — NOT a render-time fill. So a key the OAP overlay doesn't carry
 * falls through to **English**, never to the disk-shipped translation;
 * the bundled overlay reaches the UI only by being synced to OAP, exactly
 * like bundled templates. (Operators who want the full shipped
 * translation reset-to-bundled, which re-seeds the OAP row.)
 *
 * Defensive: any embedded `i18n` block on the source content is stripped
 * before the merge — the split layout never writes embedded i18n.
 */
export function localizeContent<T>(content: T, oapOverlay: unknown, locale: string): T {
  let source: T = content;
  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    const record = content as unknown as Record<string, unknown>;
    if ('i18n' in record) {
      const { i18n: _ignored, ...rest } = record;
      void _ignored;
      source = rest as unknown as T;
    }
  }
  if (locale === 'en' || oapOverlay === null || oapOverlay === undefined) return source;
  return mergeLocalizedNode(source, oapOverlay) as T;
}
