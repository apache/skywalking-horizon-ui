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
 * template, shared by the BFF's render path and the admin editor's
 * preview so both agree on what a locale renders.
 *
 * Four properties matter:
 *   1. **Source-shape preservation.** The output is structurally
 *      identical to the source: array lengths, key sets, value types
 *      all unchanged. The merger never inserts or removes keys, so the
 *      UI renders a localized template through the exact same code path
 *      as the English source.
 *   2. **Widgets match by `id`, not by position.** An array whose source
 *      entries all carry a unique non-empty string `id` is addressed by
 *      that id, so reordering / inserting / deleting a source widget
 *      never slides translations onto their neighbours. Arrays without
 *      stable ids (`expressionLabels`, `tableHeaders`, a `tab` widget's
 *      `tabs`, an overview tile's `kpis`) stay positional.
 *   3. **Drift-safe.** Overlay keys with no counterpart in the source —
 *      including an overlay entry whose `id` no longer exists — are
 *      silently ignored, as are overlay values whose type doesn't match
 *      the source's. A stale catalog never breaks rendering; at worst
 *      the reader sees English.
 *   4. **Leaf fallback to English.** Missing or empty string entries in
 *      the overlay fall through to the source. Half-translated catalogs
 *      are a valid and common state.
 *
 * Non-string leaves (numbers, booleans, null) are passed through
 * unchanged. The overlay's job is text only.
 */

/** The structural matching key. Never translated, never taken from the
 *  overlay — an overlay carries it only so the merger can find the
 *  source entry it belongs to. The guard is unconditional rather than
 *  scoped to array entries, so an overlay can't rename the dashboard it
 *  translates either. The one thing it costs: a `valueMap` / `aliases` /
 *  `slots` entry whose KEY is literally `id` can't be translated. No
 *  template has one — those keys are enum codes and label values. */
const ID_KEY = 'id';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Write `key` as an own data property.
 *
 *  `JSON.parse` makes `"__proto__"` an ordinary own key, but plain
 *  assignment routes it through `Object.prototype`'s setter: the key
 *  disappears from the result and its value silently becomes the result
 *  object's prototype. Overlay content comes off the wire, so every
 *  accumulator here writes through this instead. */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
}

function entryId(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  const id = value[ID_KEY];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * The source array's ids when it is id-addressable — every entry a plain
 * object carrying a non-empty string `id`, all ids distinct — otherwise
 * `null`.
 *
 * Uniqueness is load-bearing: a few templates repeat an id inside one
 * array on purpose (`deployment.roleToRole[].metrics` pairs a
 * `lineClient` and a `lineServer` entry under the same id), and there is
 * no way to address those by id. Such arrays stay positional.
 */
export function idAddressableIds(source: readonly unknown[]): string[] | null {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of source) {
    const id = entryId(entry);
    if (id === null || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}

/**
 * Index an overlay array by the `id` its entries carry. An empty result
 * means the array is not id-keyed — a legacy positional overlay, merged
 * by index.
 *
 * Holes (`null` / `undefined` padding that keeps a dense overlay aligned
 * with its source) are not entries and never make the array id-keyed.
 * Once ANY entry carries an id the array is id-keyed, and an entry
 * without one is dropped rather than applied positionally — mixing the
 * two addressings in one array has no meaning, and `i18n:validate`
 * reports it.
 */
export function indexOverlayById(overlay: readonly unknown[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const entry of overlay) {
    const id = entryId(entry);
    if (id === null) continue;
    // First entry wins; `i18n:validate` reports the duplicate.
    if (!out.has(id)) out.set(id, entry);
  }
  return out;
}

function indexById(overlay: readonly unknown[]): Map<string, unknown> | null {
  const out = indexOverlayById(overlay);
  return out.size > 0 ? out : null;
}

export function mergeLocalizedNode(source: unknown, overlay: unknown): unknown {
  if (Array.isArray(source)) {
    if (!Array.isArray(overlay)) return source;
    const ids = idAddressableIds(source);
    const byId = ids ? indexById(overlay) : null;
    if (ids && byId) return source.map((item, i) => mergeLocalizedNode(item, byId.get(ids[i])));
    // Source decides array length; overlay entries at indices beyond the
    // source are ignored. Sparse overlay entries (undefined / missing
    // index) recurse and fall through to the source.
    return source.map((item, i) => mergeLocalizedNode(item, overlay[i]));
  }
  if (isPlainObject(source)) {
    if (!isPlainObject(overlay)) return source;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source)) {
      // An overlay's `id` addresses the source entry; it never becomes one.
      put(out, k, k === ID_KEY && typeof v === 'string' ? v : mergeLocalizedNode(v, overlay[k]));
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
 * Copy `overlay` with the source's `id` stamped onto every entry of an
 * id-addressable array, so the result matches by id instead of by
 * position. Entries are matched to their source by the id they already
 * carry, else by index — which makes this both the migration for a
 * legacy positional overlay and an idempotent pass over an already
 * stamped one.
 *
 * Order and holes are preserved exactly: a stamped overlay still merges
 * correctly under the positional-only merger a previously-released
 * Horizon runs, so a migrated catalog can be pushed to an OAP that older
 * instances read.
 */
export function stampOverlayIds(source: unknown, overlay: unknown): unknown {
  if (overlay === null || overlay === undefined) return overlay;
  if (Array.isArray(source)) {
    if (!Array.isArray(overlay)) return overlay;
    const ids = idAddressableIds(source);
    if (!ids) return overlay.map((entry, i) => stampOverlayIds(source[i], entry));
    const byId = indexById(overlay);
    if (byId) {
      const sourceById = new Map(ids.map((id, i) => [id, source[i]]));
      return overlay.map((entry) => {
        const id = entryId(entry);
        if (id === null || !sourceById.has(id)) return entry;
        return withId(stampOverlayIds(sourceById.get(id), entry), id);
      });
    }
    return overlay.map((entry, i) => {
      const stamped = stampOverlayIds(source[i], entry);
      return i < ids.length && isPlainObject(stamped) ? withId(stamped, ids[i]) : stamped;
    });
  }
  if (isPlainObject(source)) {
    if (!isPlainObject(overlay)) return overlay;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(overlay)) {
      put(out, k, k in source ? stampOverlayIds(source[k], v) : v);
    }
    return out;
  }
  return overlay;
}

/**
 * Copy `overlay` reordered into the source's order: every id-addressable
 * array comes back with one slot per source entry, filled by the overlay
 * entry carrying that id (`null` where the overlay has nothing to say).
 * Arrays without stable ids, and legacy overlays that carry no ids at
 * all, pass through positionally.
 *
 * This is the read-side counterpart to {@link stampOverlayIds}: it lets
 * an index-addressed reader — the translation editor walks the source
 * and pulls each field by its positional path — see the right entry
 * after the source has been reordered. Without it the editor would show
 * a neighbour's translation and write that misalignment back on the next
 * push, even though the render path resolved the ids correctly.
 */
export function alignOverlayToSource(source: unknown, overlay: unknown): unknown {
  if (overlay === null || overlay === undefined) return overlay;
  if (Array.isArray(source)) {
    if (!Array.isArray(overlay)) return overlay;
    const ids = idAddressableIds(source);
    const byId = ids ? indexById(overlay) : null;
    if (ids && byId) return ids.map((id, i) => alignOverlayToSource(source[i], byId.get(id)) ?? null);
    return overlay.map((entry, i) => alignOverlayToSource(source[i], entry));
  }
  if (isPlainObject(source)) {
    if (!isPlainObject(overlay)) return overlay;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(overlay)) {
      put(out, k, k in source ? alignOverlayToSource(source[k], v) : v);
    }
    return out;
  }
  return overlay;
}

/**
 * The one shape a given set of translations has: stamped with source
 * ids, ordered and padded to the source, `null` wherever the overlay
 * says nothing. Legacy positional input and id-addressed input for the
 * same translations canonicalize to identical bytes, which is what lets
 * the admin editor tell a real edit from a re-shaped catalog — and what
 * makes an operator's push byte-identical to what the seeder writes.
 */
export function canonicalizeOverlay(source: unknown, overlay: unknown): unknown {
  return alignOverlayToSource(source, stampOverlayIds(source, overlay));
}

/** `entry` with `id` first — the matching key reads ahead of the prose
 *  it addresses, and re-stamping never leaves a stale id behind. */
function withId(entry: unknown, id: string): unknown {
  if (!isPlainObject(entry)) return entry;
  const { [ID_KEY]: _replaced, ...rest } = entry;
  void _replaced;
  return { [ID_KEY]: id, ...rest };
}
