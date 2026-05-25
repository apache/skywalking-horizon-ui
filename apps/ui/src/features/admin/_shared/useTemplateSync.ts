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
 * Per-admin-page hook into the BFF's OAP UI-template sync state. Three
 * pieces every admin page needs:
 *
 *   - `readOnly` — true when the BFF cannot reach OAP's admin port
 *     right now. The page shows the unreachable banner and disables
 *     every Save / Create / Delete control. Operators can still view
 *     bundled content; mutations would silently fail otherwise.
 *
 *   - `banner` — small object the shared `SyncStatusBanner` renders.
 *     Severity tells the banner which design token to use; counts
 *     tells the operator what the page-level state is in one glance.
 *
 *   - `badgeFor(name)` — per-row lookup. Returns the status string a
 *     row-level badge renders, or `null` when no remote info exists.
 *
 * Source of truth: the `syncStatus` envelope inside the configBundle
 * (refreshed when AppShell mounts). No additional network call.
 */

import { computed, type ComputedRef } from 'vue';
import { useConfigBundle } from '@/controls/configBundle';
import { useLocalTemplateEdits } from '@/controls/localTemplateEdits';
import type {
  BundleSyncStatus,
  TemplateBadge,
  TemplateConflict,
  TemplateKind,
  TemplateStatus,
} from '@/api/scopes/configs';

export type BannerSeverity = 'unreachable' | 'conflict' | 'diverged' | 'clean' | 'unknown';

export interface SyncBanner {
  severity: BannerSeverity;
  /** One-line headline for the admin page top strip. */
  message: string;
  /** Optional secondary text shown smaller. */
  detail?: string;
  /** Per-status counts for the kinds owned by this page. */
  counts: Partial<Record<TemplateStatus, number>>;
  /** Unpublished local browser drafts for this page's kind. */
  localCount: number;
  /** Per-name multi-enabled OAP conflicts for this kind. The banner
   *  surfaces these as a `conflict` severity above any diverged /
   *  clean state — they're a higher-priority "something needs
   *  attention". */
  conflicts: TemplateConflict[];
}

export interface UseTemplateSyncOptions {
  /** Limit banner counts + badges to one kind — admin pages care only
   *  about their own family. */
  kind: TemplateKind;
}

export interface UseTemplateSyncReturn {
  readOnly: ComputedRef<boolean>;
  banner: ComputedRef<SyncBanner>;
  badgeFor: (name: string) => TemplateStatus | null;
  status: ComputedRef<BundleSyncStatus | null>;
}

export function useTemplateSync(opts: UseTemplateSyncOptions): UseTemplateSyncReturn {
  const { bundle } = useConfigBundle();
  const localEdits = useLocalTemplateEdits();

  // Unpublished local browser drafts for this kind (`horizon.<kind>.*`).
  const localCount = computed<number>(
    () => localEdits.names().filter((n) => n.startsWith(`horizon.${opts.kind}.`)).length,
  );

  const status = computed<BundleSyncStatus | null>(() => bundle.value?.syncStatus ?? null);

  const ownBadges = computed<TemplateBadge[]>(() => {
    const s = status.value;
    if (!s) return [];
    return s.badges.filter((b) => b.kind === opts.kind);
  });

  const ownConflicts = computed<TemplateConflict[]>(() => {
    const s = status.value;
    if (!s) return [];
    return (s.conflicts ?? []).filter((c) => c.kind === opts.kind);
  });

  const readOnly = computed<boolean>(() => status.value?.unreachable === true);

  // Shown on diverged + clean banners so the operator always knows what
  // the two axes mean.
  const GLOSSARY =
    'Diverged = the bundled (shipped) default differs from the version live on OAP — OAP wins at render time. ' +
    'Local = unpublished edits saved only in this browser; publish with “Check diff & push”.';
  const localSuffix = computed(() =>
    localCount.value > 0
      ? ` · ${localCount.value} local draft${localCount.value === 1 ? '' : 's'} in this browser`
      : '',
  );

  const banner = computed<SyncBanner>(() => {
    const s = status.value;
    if (!s) {
      return {
        severity: 'unknown',
        message: 'Loading template sync status…',
        counts: {},
        localCount: localCount.value,
        conflicts: [],
      };
    }
    const counts: Partial<Record<TemplateStatus, number>> = {};
    for (const b of ownBadges.value) counts[b.status] = (counts[b.status] ?? 0) + 1;

    if (s.unreachable) {
      const last = s.lastSuccessfulSyncAt
        ? new Date(s.lastSuccessfulSyncAt).toLocaleString()
        : null;
      return {
        severity: 'unreachable',
        message:
          'OAP admin port unreachable — this page is READ-ONLY. Bundled templates shown; edits are disabled until OAP is back.',
        detail: last
          ? `Last successful sync: ${last}`
          : 'No successful sync yet since this BFF started.',
        counts,
        localCount: localCount.value,
        conflicts: [],
      };
    }
    if (ownConflicts.value.length > 0) {
      const names = ownConflicts.value.map((c) => c.name).join(', ');
      return {
        severity: 'conflict',
        message: `${ownConflicts.value.length} template${
          ownConflicts.value.length === 1 ? '' : 's'
        } on OAP have multiple enabled records — using the lowest-id row for each.`,
        detail: `Affected: ${names}. Open the affected row's diff modal and disable the extras to clean up.`,
        counts,
        localCount: localCount.value,
        conflicts: ownConflicts.value,
      };
    }
    const diverged = counts.diverged ?? 0;
    const remoteOnly = counts['remote-only'] ?? 0;
    const disabled = counts.disabled ?? 0;
    if (diverged + remoteOnly + disabled > 0 || localCount.value > 0) {
      const parts: string[] = [];
      if (diverged > 0) parts.push(`${diverged} diverged`);
      if (remoteOnly > 0) parts.push(`${remoteOnly} remote-only`);
      if (disabled > 0) parts.push(`${disabled} disabled`);
      if (localCount.value > 0) parts.push(`${localCount.value} local`);
      return {
        severity: localCount.value > 0 || diverged > 0 ? 'diverged' : 'clean',
        message: `Synced from OAP — ${parts.length ? parts.join(', ') : 'all match bundled'}.`,
        detail: GLOSSARY,
        counts,
        localCount: localCount.value,
        conflicts: [],
      };
    }
    return {
      severity: 'clean',
      message: `Synced from OAP — all ${ownBadges.value.length} templates match bundled.${localSuffix.value}`,
      detail: GLOSSARY,
      counts,
      localCount: localCount.value,
      conflicts: [],
    };
  });

  const badgeIndex = computed<Map<string, TemplateStatus>>(() => {
    const m = new Map<string, TemplateStatus>();
    for (const b of ownBadges.value) m.set(b.name, b.status);
    return m;
  });

  function badgeFor(name: string): TemplateStatus | null {
    return badgeIndex.value.get(name) ?? null;
  }

  return { readOnly, banner, badgeFor, status };
}
