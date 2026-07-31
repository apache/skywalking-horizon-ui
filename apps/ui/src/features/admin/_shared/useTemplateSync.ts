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
 *   - `conflictFor(name)` / `conflictBannerFor(name)` — per-row and
 *     per-selection duplicate lookup. A name OAP stores on more than
 *     one enabled record is ambiguous; Horizon reports it and resolves
 *     nothing, so every surface that can show one template at a time
 *     has to say so explicitly.
 *
 * Source of truth: the `syncStatus` envelope inside the configBundle
 * (refreshed when AppShell mounts). No additional network call.
 */

import { computed, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConfigBundle } from '@/controls/configBundle';
import { useLocalTemplateEdits } from '@/controls/localTemplateEdits';
import type {
  BundleSyncStatus,
  TemplateBadge,
  TemplateConflict,
  TemplateKind,
  TemplateStatus,
} from '@/api/scopes/configs';

export type BannerSeverity = 'unreachable' | 'readonly' | 'conflict' | 'diverged' | 'clean' | 'unknown';

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
  /** The duplicate row for `name`, or `null` when OAP has a single
   *  enabled record for it. Drives the picker's duplicate chip. */
  conflictFor: (name: string) => TemplateConflict | null;
  /** Banner scoped to ONE template — `null` unless that template is
   *  duplicated. */
  conflictBannerFor: (name: string) => SyncBanner | null;
  status: ComputedRef<BundleSyncStatus | null>;
}

/** vue-i18n's `t` narrowed to the single call form the banner builder
 *  needs, so the builder stays pure (and unit-testable without an app
 *  instance) instead of reaching for a composable. */
export type BannerTranslate = (key: string, named?: Record<string, unknown>) => string;

/** The conflict row for `name` inside `kind`, or `null` when OAP has a
 *  single enabled record for it. Kind is part of the lookup because the
 *  bundle carries every kind's conflicts and a layer key can collide
 *  with an overview id. Tolerates a bundle without the field (an older
 *  BFF), which reports no conflicts rather than throwing. */
export function conflictOf(
  conflicts: TemplateConflict[] | null | undefined,
  kind: TemplateKind,
  name: string,
): TemplateConflict | null {
  if (!conflicts) return null;
  return conflicts.find((c) => c.kind === kind && c.name === name) ?? null;
}

/** Conflict banner for ONE template. The page-level banner counts every
 *  conflict of the kind at once, which never tells the operator whether
 *  the row they just opened is an ambiguous one — this names that row
 *  and lists the OAP record ids they need to clean it up. */
export function buildConflictBanner(conflict: TemplateConflict, t: BannerTranslate): SyncBanner {
  return {
    severity: 'conflict',
    message: t('“{name}” is duplicated on OAP — {n} enabled records carry this template name.', {
      name: conflict.name,
      n: conflict.enabledIds.length,
    }),
    detail: t(
      'Enabled record ids: {ids}. Horizon renders the lowest-id copy and changes nothing on its own — retiring a row is irreversible (OAP has no delete), so clean this up on OAP once you have confirmed which copy you want to keep.',
      { ids: conflict.enabledIds.join(', ') },
    ),
    counts: {},
    localCount: 0,
    conflicts: [conflict],
  };
}

export function useTemplateSync(opts: UseTemplateSyncOptions): UseTemplateSyncReturn {
  const { t } = useI18n({ useScope: 'global' });
  const translate: BannerTranslate = (key, named) => (named ? t(key, named) : t(key));
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

  // Read-only when OAP admin is unreachable (live mode, transient) OR the BFF
  // is deliberately in readonly template mode (rendering the local bundle).
  const readOnly = computed<boolean>(
    () => status.value?.unreachable === true || status.value?.mode === 'readonly',
  );

  // Shown on diverged + clean banners so the operator always knows what
  // the two axes mean.
  const GLOSSARY =
    t('Diverged = the bundled (shipped) default differs from the version live on OAP — OAP wins at render time.') +
    ' ' +
    t('Local = unpublished edits saved only in this browser; publish with “Check diff & push”.');
  const localSuffix = computed(() =>
    localCount.value > 0
      ? ` · ${t('{n} local drafts in this browser', localCount.value, { named: { n: localCount.value } })}`
      : '',
  );

  const banner = computed<SyncBanner>(() => {
    const s = status.value;
    if (!s) {
      return {
        severity: 'unknown',
        message: t('Loading template sync status…'),
        counts: {},
        localCount: localCount.value,
        conflicts: [],
      };
    }
    const counts: Partial<Record<TemplateStatus, number>> = {};
    for (const b of ownBadges.value) counts[b.status] = (counts[b.status] ?? 0) + 1;

    if (s.mode === 'readonly') {
      return {
        severity: 'readonly',
        message: t(
          'Read-only mode — templates are served from the local bundle. Editing and publishing are disabled.',
        ),
        detail: t(
          'Set templates.mode=live (HORIZON_TEMPLATES_MODE=live) with OAP’s ui_template store reachable to edit.',
        ),
        counts,
        localCount: localCount.value,
        conflicts: [],
      };
    }
    if (s.unreachable) {
      const last = s.lastSuccessfulSyncAt
        ? new Date(s.lastSuccessfulSyncAt).toLocaleString()
        : null;
      return {
        severity: 'unreachable',
        message: t(
          'OAP admin port unreachable — this page is READ-ONLY. Bundled templates shown; edits are disabled until OAP is back.',
        ),
        detail: last
          ? t('Last successful sync: {at}', { at: last })
          : t('No successful sync yet since this BFF started.'),
        counts,
        localCount: localCount.value,
        conflicts: [],
      };
    }
    if (ownConflicts.value.length > 0) {
      // The row ids are the point: OAP's disable takes an id, not a name, so
      // an operator cleaning this up on OAP has nothing to act on without them.
      const names = ownConflicts.value
        .map((c) => `${c.name} (${c.enabledIds.join(', ')})`)
        .join('; ');
      return {
        severity: 'conflict',
        message: t(
          '{n} templates on OAP have more than one enabled record — Horizon renders one copy of each and changes nothing on its own.',
          ownConflicts.value.length,
          { named: { n: ownConflicts.value.length } },
        ),
        detail: t(
          'Affected: {names}. Horizon renders the lowest-id copy and changes nothing on its own — retiring a row is irreversible (OAP has no delete), so clean this up on OAP once you have confirmed which copy you want to keep.',
          { names },
        ),
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
      if (diverged > 0) parts.push(t('{n} diverged', { n: diverged }));
      if (remoteOnly > 0) parts.push(t('{n} remote-only', { n: remoteOnly }));
      if (disabled > 0) parts.push(t('{n} disabled', { n: disabled }));
      if (localCount.value > 0) parts.push(t('{n} local', { n: localCount.value }));
      return {
        severity: localCount.value > 0 || diverged > 0 ? 'diverged' : 'clean',
        message: t('Synced from OAP — {summary}.', {
          summary: parts.length ? parts.join(', ') : t('all match bundled'),
        }),
        detail: GLOSSARY,
        counts,
        localCount: localCount.value,
        conflicts: [],
      };
    }
    return {
      severity: 'clean',
      message:
        t('Synced from OAP — {n} templates match bundled defaults.', { n: ownBadges.value.length }) +
        localSuffix.value,
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

  function conflictFor(name: string): TemplateConflict | null {
    return conflictOf(status.value?.conflicts, opts.kind, name);
  }

  function conflictBannerFor(name: string): SyncBanner | null {
    const c = conflictFor(name);
    return c ? buildConflictBanner(c, translate) : null;
  }

  return { readOnly, banner, badgeFor, conflictFor, conflictBannerFor, status };
}
