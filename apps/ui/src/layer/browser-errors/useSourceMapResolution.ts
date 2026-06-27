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
 * Source-map de-obfuscation state for the Browser Logs tab (#6784): the
 * BFF-memory source-map cache (list / upload / remove, shared by the
 * manager panel + the per-row picker) plus the one-row-open-at-a-time
 * expand + resolve flow (raw stack → original frames against the chosen
 * map). The host owns row data + the loaded-result watch that calls
 * `closeExpanded`; this owns the source-map cache + resolution lifecycle.
 *
 * Maps load on mount; `loadMaps` is also exposed so the manager's manual
 * refresh re-syncs. `t` is threaded in so the upload/resolve error wording
 * resolves against the host's i18n scope.
 */

import { onMounted, ref, type Ref } from 'vue';
import type {
  BrowserErrorRow,
  ResolveResponse,
  SourceMapDescriptor,
  SourceMapUsage,
} from '@/api/client';
import { bffClient, describeApiError } from '@/api/client';

export interface SourceMapResolution {
  showMaps: Ref<boolean>;
  sourceMaps: Ref<SourceMapDescriptor[]>;
  usage: Ref<SourceMapUsage | null>;
  mapsEnabled: Ref<boolean>;
  mapsBusy: Ref<boolean>;
  mapsError: Ref<string | null>;
  loadMaps: () => Promise<void>;
  onUpload: (file: File) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  expanded: Ref<number | null>;
  selectedMapId: Ref<string>;
  resolved: Ref<ResolveResponse | null>;
  resolveBusy: Ref<boolean>;
  resolveErr: Ref<string | null>;
  closeExpanded: () => void;
  toggleRow: (idx: number) => void;
  resolveRow: (row: BrowserErrorRow) => Promise<void>;
}

export function useSourceMapResolution(t: (key: string, named?: Record<string, unknown>) => string): SourceMapResolution {
  const showMaps = ref(false);
  const sourceMaps = ref<SourceMapDescriptor[]>([]);
  const usage = ref<SourceMapUsage | null>(null);
  const mapsEnabled = ref(true);
  const mapsBusy = ref(false);
  const mapsError = ref<string | null>(null);

  const expanded = ref<number | null>(null);
  const selectedMapId = ref<string>('');
  const resolved = ref<ResolveResponse | null>(null);
  const resolveBusy = ref(false);
  const resolveErr = ref<string | null>(null);

  async function loadMaps(): Promise<void> {
    try {
      const res = await bffClient.browserErrors.listSourceMaps();
      sourceMaps.value = res.maps;
      usage.value = res.usage;
      mapsEnabled.value = res.enabled;
      mapsError.value = null;
    } catch (err) {
      mapsError.value = describeApiError(err);
    }
  }
  async function onUpload(file: File): Promise<void> {
    mapsBusy.value = true;
    mapsError.value = null;
    try {
      const res = await bffClient.browserErrors.uploadSourceMap(file);
      if (!res.ok) mapsError.value = t('Upload rejected: {reason}', { reason: res.error ?? t('unknown') });
      await loadMaps();
      if (res.ok && res.map && !selectedMapId.value) selectedMapId.value = res.map.id;
    } catch (err) {
      mapsError.value = describeApiError(err);
    } finally {
      mapsBusy.value = false;
    }
  }
  async function onRemove(id: string): Promise<void> {
    mapsBusy.value = true;
    try {
      await bffClient.browserErrors.deleteSourceMap(id);
      if (selectedMapId.value === id) selectedMapId.value = '';
      await loadMaps();
    } catch (err) {
      mapsError.value = describeApiError(err);
    } finally {
      mapsBusy.value = false;
    }
  }
  onMounted(loadMaps);

  function closeExpanded(): void {
    expanded.value = null;
    resolved.value = null;
    resolveErr.value = null;
  }
  function toggleRow(idx: number): void {
    if (expanded.value === idx) {
      closeExpanded();
      return;
    }
    expanded.value = idx;
    resolved.value = null;
    resolveErr.value = null;
    if (!selectedMapId.value && sourceMaps.value.length > 0) selectedMapId.value = sourceMaps.value[0].id;
  }
  async function resolveRow(row: BrowserErrorRow): Promise<void> {
    if (!selectedMapId.value) return;
    resolveBusy.value = true;
    resolveErr.value = null;
    resolved.value = null;
    try {
      const res = await bffClient.browserErrors.resolve({
        stack: row.stack ?? undefined,
        line: row.line ?? undefined,
        col: row.col ?? undefined,
        errorUrl: row.errorUrl ?? undefined,
        category: row.category,
        sourceMapId: selectedMapId.value,
      });
      resolved.value = res;
      if (!res.ok) resolveErr.value = t('Could not resolve: {reason}', { reason: res.error ?? t('unknown') });
    } catch (err) {
      resolveErr.value = describeApiError(err);
    } finally {
      resolveBusy.value = false;
    }
  }

  return {
    showMaps,
    sourceMaps,
    usage,
    mapsEnabled,
    mapsBusy,
    mapsError,
    loadMaps,
    onUpload,
    onRemove,
    expanded,
    selectedMapId,
    resolved,
    resolveBusy,
    resolveErr,
    closeExpanded,
    toggleRow,
    resolveRow,
  };
}
