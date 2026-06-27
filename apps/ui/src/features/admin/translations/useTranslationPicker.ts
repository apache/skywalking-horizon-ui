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
 * Entry-list assembly for the Translations picker.
 *
 * Builds the overview / layer `TemplatePickerEntry[]` (remote rows plus the
 * bundled-only rows that come off the sync-status badge list) and the per-row
 * metadata — sync badge, has-local-draft flag, divergence, and the per-locale
 * status chips (overlay sync state, with the operator's unstaged browser draft
 * taking precedence). The active list switches on the picker's selected kind.
 */

import { computed, type ComputedRef, type Ref } from 'vue';
import { useTemplateSources } from '@/features/admin/_shared/useTemplateSources';
import { useTemplateSync } from '@/features/admin/_shared/useTemplateSync';
import { type TemplatePickerEntry } from '@/features/admin/_shared/TemplatePicker.vue';
import { useLocalTranslationEdits } from '@/controls/localTranslationEdits';
import { SUPPORTED_LOCALES } from '@/i18n';
import type { AdminLayerTemplate } from '@/api/client';
import type { OverviewDashboard } from '@skywalking-horizon-ui/api-client';

export interface UseTranslationPickerReturn {
  overviewSources: ReturnType<typeof useTemplateSources>;
  layerSources: ReturnType<typeof useTemplateSources>;
  layerSync: ReturnType<typeof useTemplateSync>;
  overviewSync: ReturnType<typeof useTemplateSync>;
  overviewEntries: ComputedRef<TemplatePickerEntry[]>;
  layerEntries: ComputedRef<TemplatePickerEntry[]>;
  activeEntries: ComputedRef<TemplatePickerEntry[]>;
}

export function useTranslationPicker(selectedKind: Ref<'overview' | 'layer'>): UseTranslationPickerReturn {
  const overviewSources = useTemplateSources('overview');
  const layerSources = useTemplateSources('layer');
  const layerSync = useTemplateSync({ kind: 'layer' });
  const overviewSync = useTemplateSync({ kind: 'overview' });
  const localEdits = useLocalTranslationEdits();

  // Bundled-only entries (overview / layer rows the operator may not
  // have pushed yet) come off the sync-status badge list.
  const bundledOverviewNames = computed<string[]>(() => {
    const s = overviewSync.status.value;
    return s ? s.badges.filter((b) => b.kind === 'overview').map((b) => b.name) : [];
  });
  const layerNames = computed<string[]>(() => {
    const s = layerSync.status.value;
    return s ? s.badges.filter((b) => b.kind === 'layer').map((b) => b.name) : [];
  });

  function metaFor(name: string, kind: 'overview' | 'layer'): {
    syncBadge: ReturnType<typeof layerSync.badgeFor>;
    hasLocalDraft: boolean;
    isDiverged: boolean;
    localeBadges: TemplatePickerEntry['localeBadges'];
  } {
    const sync = kind === 'overview' ? overviewSync : layerSync;
    const sources = kind === 'overview' ? overviewSources : layerSources;
    const badge = sync.badgeFor(name);
    // Per-locale status chips: derived from the overlay sibling rows
    // already present in sync-status, with the operator's unstaged
    // browser draft taking precedence ('local' wins over any sync state).
    const localeBadges = SUPPORTED_LOCALES.filter((l) => l !== 'en').map((locale) => {
      if (localEdits.has(name, locale)) {
        return { locale, status: 'local' as const };
      }
      const s = sources.overlayStatus(name, locale);
      return { locale, status: s ?? ('empty' as const) };
    });
    return {
      syncBadge: badge,
      // Picker chip lights up when ANY locale has an unstaged draft for
      // this template.
      hasLocalDraft: localEdits.localesFor(name).length > 0,
      isDiverged: badge === 'diverged',
      localeBadges,
    };
  }

  const overviewEntries = computed<TemplatePickerEntry[]>(() => {
    const out: TemplatePickerEntry[] = [];
    const seen = new Set<string>();
    const push = (name: string, content: OverviewDashboard | null): void => {
      if (!content || seen.has(name)) return;
      seen.add(name);
      out.push({
        value: name,
        label: content.title || content.id,
        key: content.id,
        ...metaFor(name, 'overview'),
      });
    };
    for (const name of overviewSources.remoteNames()) {
      push(name, overviewSources.remote<OverviewDashboard>(name));
    }
    for (const name of bundledOverviewNames.value) {
      push(name, overviewSources.bundled<OverviewDashboard>(name));
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  });

  const layerEntries = computed<TemplatePickerEntry[]>(() => {
    const out: TemplatePickerEntry[] = [];
    for (const name of layerNames.value) {
      const content =
        layerSources.remote<AdminLayerTemplate>(name) ??
        layerSources.bundled<AdminLayerTemplate>(name);
      if (!content) continue;
      out.push({
        value: name,
        label: content.alias || content.key,
        key: content.key,
        color: content.color,
        ...metaFor(name, 'layer'),
      });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  });

  const activeEntries = computed<TemplatePickerEntry[]>(() =>
    selectedKind.value === 'overview' ? overviewEntries.value : layerEntries.value,
  );

  return {
    overviewSources,
    layerSources,
    layerSync,
    overviewSync,
    overviewEntries,
    layerEntries,
    activeEntries,
  };
}
