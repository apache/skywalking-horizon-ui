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
 * Upgrade-safe migration for index-aligned translation overlays when
 * widgets are inserted into the middle of a source dashboard array.
 *
 * Runtime merge (`mergeLocalizedNode`) pairs overlay entries to source
 * widgets by array index. Inserting widgets into the source without
 * inserting matching overlay slots shifts every later translation onto
 * the wrong widget. `seedMissingOverlays` skips OAP rows that already
 * exist, so bundled i18n alone cannot repair upgraded deployments.
 *
 * Scheme: detect a known contiguous insert in the **source** widget
 * list, and when the overlay's matching array is exactly that many
 * entries short, splice in the bundled default slots at the insert
 * index. Existing overlay entries are preserved unchanged (operator
 * customizations stay put).
 */

/** Widget ids inserted by the Node.js 6→12 meters UI change, in order. */
export const NODEJS_RUNTIME_METERS_V2_INSERT_IDS = [
  'nodejs_array_buffers',
  'nodejs_uptime',
  'nodejs_peak_malloced_memory',
  'nodejs_malloced_memory',
  'nodejs_old_space_used',
  'nodejs_new_space_used',
] as const;

interface WidgetLike {
  id?: unknown;
}

function instanceWidgets(content: unknown): WidgetLike[] | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const dashboards = (content as Record<string, unknown>).dashboards;
  if (!dashboards || typeof dashboards !== 'object' || Array.isArray(dashboards)) return null;
  const instance = (dashboards as Record<string, unknown>).instance;
  return Array.isArray(instance) ? (instance as WidgetLike[]) : null;
}

function instanceOverlayEntries(content: unknown): unknown[] | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const dashboards = (content as Record<string, unknown>).dashboards;
  if (!dashboards || typeof dashboards !== 'object' || Array.isArray(dashboards)) return null;
  const instance = (dashboards as Record<string, unknown>).instance;
  return Array.isArray(instance) ? instance : null;
}

/** Index in `source` where {@link NODEJS_RUNTIME_METERS_V2_INSERT_IDS} starts, or -1. */
export function nodejsRuntimeMetersV2InsertAt(sourceContent: unknown): number {
  const widgets = instanceWidgets(sourceContent);
  if (!widgets) return -1;
  const insertAt = widgets.findIndex((w) => w.id === NODEJS_RUNTIME_METERS_V2_INSERT_IDS[0]);
  if (insertAt < 0) return -1;
  for (let i = 0; i < NODEJS_RUNTIME_METERS_V2_INSERT_IDS.length; i++) {
    if (widgets[insertAt + i]?.id !== NODEJS_RUNTIME_METERS_V2_INSERT_IDS[i]) return -1;
  }
  return insertAt;
}

function entryTitle(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const title = (entry as Record<string, unknown>).title;
  return typeof title === 'string' && title.length > 0 ? title : null;
}

/**
 * Fingerprint the short-overlay candidate: `oapEntries[insertAt]` must still
 * look like the widget that sat there before the insert (now at
 * `insertAt + insertCount` in the new source / bundled overlay) — typically
 * JVM CPU — and must not look like one of the six newly inserted Node panels.
 *
 * Accepts:
 *   - default bundled title matching the post-insert tail slot
 *   - operator-customized titles that are not any of the six new Node titles
 *   - empty / null / title-less overlay objects (leaf fallback to English)
 */
export function looksLikePreInsertTailEntry(
  oapEntry: unknown,
  bundledEntries: unknown[],
  insertAt: number,
  insertCount: number,
): boolean {
  const oapTitle = entryTitle(oapEntry);
  const expectedTitle = entryTitle(bundledEntries[insertAt + insertCount]);

  if (oapTitle !== null && expectedTitle !== null && oapTitle === expectedTitle) {
    return true;
  }

  if (oapTitle !== null) {
    for (let i = 0; i < insertCount; i++) {
      const newTitle = entryTitle(bundledEntries[insertAt + i]);
      if (newTitle !== null && newTitle === oapTitle) return false;
    }
    // Customized (or other locale drift) but not a new-Node title.
    return true;
  }

  // null / undefined / {} / tip-only — still a plausible pre-insert slot.
  return oapEntry === null || oapEntry === undefined || typeof oapEntry === 'object';
}

/**
 * If `oapOverlay` is the pre-insert shape for a source that already
 * contains the six Node.js v2 widgets, return a new overlay with those
 * six bundled slots spliced in. Otherwise return the original overlay
 * and `migrated: false`.
 *
 * Bundled slots fill the gap (defaults for new panels). Every entry
 * that already existed in `oapOverlay` is kept as-is.
 */
export function migrateNodejsRuntimeMetersV2Overlay(
  sourceContent: unknown,
  oapOverlay: unknown,
  bundledOverlay: unknown,
): { content: unknown; migrated: boolean } {
  const insertAt = nodejsRuntimeMetersV2InsertAt(sourceContent);
  if (insertAt < 0) return { content: oapOverlay, migrated: false };

  const sourceWidgets = instanceWidgets(sourceContent)!;
  const oapEntries = instanceOverlayEntries(oapOverlay);
  if (!oapEntries) return { content: oapOverlay, migrated: false };

  const insertCount = NODEJS_RUNTIME_METERS_V2_INSERT_IDS.length;
  // Exact shortfall of the known insert — other length deltas are not this migration.
  if (oapEntries.length !== sourceWidgets.length - insertCount) {
    return { content: oapOverlay, migrated: false };
  }

  const bundledEntries = instanceOverlayEntries(bundledOverlay) ?? [];
  // Refuse when the slot at insertAt already looks like a new Node panel
  // (e.g. a full overlay truncated at the tail by exactly six entries).
  if (!looksLikePreInsertTailEntry(oapEntries[insertAt], bundledEntries, insertAt, insertCount)) {
    return { content: oapOverlay, migrated: false };
  }

  const slots: unknown[] = [];
  for (let i = 0; i < insertCount; i++) {
    const fromBundled = bundledEntries[insertAt + i];
    // Empty object → leaf fallback to English source titles/tips.
    slots.push(fromBundled !== undefined ? structuredClone(fromBundled) : {});
  }

  const migratedInstance = [
    ...oapEntries.slice(0, insertAt),
    ...slots,
    ...oapEntries.slice(insertAt),
  ];

  const dashboards = {
    ...((oapOverlay as Record<string, unknown>).dashboards as Record<string, unknown>),
    instance: migratedInstance,
  };
  return {
    content: { ...(oapOverlay as Record<string, unknown>), dashboards },
    migrated: true,
  };
}
