<!--
  Licensed to the Apache Software Foundation (ASF) under one or more
  contributor license agreements.  See the NOTICE file distributed with
  this work for additional information regarding copyright ownership.
  The ASF licenses this file to You under the Apache License, Version 2.0
  (the "License"); you may not use this file except in compliance with
  the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->
<!--
  Source-map cache manager for the Browser Errors tab. Presentational:
  the parent owns the data (list + usage) and the API calls; this emits
  upload / remove / refresh. Surfaces the "maps are temporary, in BFF
  memory" caveat + a usage bar so operators understand eviction.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SourceMapDescriptor, SourceMapUsage } from '@/api/client';
import Btn from '@/components/primitives/Btn.vue';
import Icon from '@/components/icons/Icon.vue';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  maps: SourceMapDescriptor[];
  usage: SourceMapUsage | null;
  enabled: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{
  (e: 'upload', file: File): void;
  (e: 'remove', id: string): void;
  (e: 'refresh'): void;
}>();

const fileInput = ref<HTMLInputElement | null>(null);

function pick(): void {
  fileInput.value?.click();
}
function onFile(ev: Event): void {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) emit('upload', file);
  input.value = ''; // allow re-uploading the same filename
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const usedPct = computed(() => {
  if (!props.usage || props.usage.maxTotalBytes <= 0) return 0;
  return Math.min(100, Math.round((props.usage.usedBytes / props.usage.maxTotalBytes) * 100));
});
</script>

<template>
  <div class="smm">
    <div class="smm-head">
      <div class="smm-title"><Icon name="fn" /><span>{{ t('Source maps') }}</span></div>
      <div class="smm-actions">
        <Btn size="sm" kind="ghost" :disabled="busy" @click="emit('refresh')"><Icon name="refresh" />{{ t('Refresh') }}</Btn>
        <Btn size="sm" kind="primary" :disabled="!enabled || busy" @click="pick"><Icon name="plus" />{{ t('Upload .map') }}</Btn>
        <input ref="fileInput" type="file" accept=".map,application/json" hidden @change="onFile" />
      </div>
    </div>

    <p v-if="!enabled" class="smm-note smm-note--off">
      {{ t('Source-map de-obfuscation is disabled on this server (sourceMaps.enabled: false).') }}
    </p>
    <template v-else>
      <p class="smm-note">
        {{ t('Uploaded maps are held in the server memory only — evicted least-recently-used under memory pressure and lost on restart. For durable provisioning, mount .map files into the server\'s static source-map directory; those are reloaded automatically and can\'t be deleted here.') }}
      </p>

      <div v-if="usage" class="smm-usage">
        <div class="smm-bar"><span class="smm-bar-fill" :style="{ width: usedPct + '%' }" /></div>
        <span class="smm-usage-txt">
          {{ t('{used} / {total} · {count} maps · max {perFile}/file', {
            used: fmtBytes(usage.usedBytes),
            total: fmtBytes(usage.maxTotalBytes),
            count: maps.length,
            perFile: fmtBytes(usage.maxFileBytes),
          }) }}
        </span>
      </div>

      <ul v-if="maps.length > 0" class="smm-list">
        <li v-for="m in maps" :key="m.id" class="smm-item">
          <span class="smm-name" :title="m.label">{{ m.label }}</span>
          <span class="smm-badge" :class="m.origin === 'mount' ? 'is-mount' : 'is-upload'">
            {{ m.origin === 'mount' ? t('Mounted') : t('Uploaded · temporary') }}
          </span>
          <span class="smm-meta">{{ fmtBytes(m.bytes) }}</span>
          <span class="smm-meta">{{ fmtAge(m.addedAt) }}</span>
          <button
            v-if="m.origin === 'upload'"
            class="smm-del"
            :disabled="busy"
            :title="t('Remove from memory')"
            @click="emit('remove', m.id)"
          >
            <Icon name="more" />{{ t('Remove') }}
          </button>
          <span v-else class="smm-meta smm-meta--dim">{{ t('durable') }}</span>
        </li>
      </ul>
      <p v-else class="smm-empty">{{ t('No source maps loaded. Upload a .map to de-obfuscate stacks.') }}</p>
    </template>
  </div>
</template>

<style scoped>
.smm {
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  background: var(--sw-bg-1);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.smm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.smm-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 13px;
  color: var(--sw-fg-1);
}
.smm-actions {
  display: flex;
  gap: 6px;
}
.smm-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--sw-fg-2);
}
.smm-note--off {
  color: var(--sw-warn);
}
.smm-note code,
.smm-empty code {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-1);
}
.smm-usage {
  display: flex;
  align-items: center;
  gap: 8px;
}
.smm-bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--sw-bg-2);
  overflow: hidden;
}
.smm-bar-fill {
  display: block;
  height: 100%;
  background: var(--sw-cyan);
  transition: width 0.2s ease;
}
.smm-usage-txt {
  font-size: 11px;
  color: var(--sw-fg-2);
  white-space: nowrap;
}
.smm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.smm-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 8px;
  border-radius: 4px;
  background: var(--sw-bg-2);
  font-size: 12px;
}
.smm-name {
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.smm-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  white-space: nowrap;
}
.smm-badge.is-upload {
  color: var(--sw-warn);
  background: color-mix(in srgb, var(--sw-warn) 15%, transparent);
}
.smm-badge.is-mount {
  color: var(--sw-info);
  background: color-mix(in srgb, var(--sw-info) 15%, transparent);
}
.smm-meta {
  font-size: 11px;
  color: var(--sw-fg-2);
  white-space: nowrap;
}
.smm-meta--dim {
  opacity: 0.6;
}
.smm-del {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: transparent;
  color: var(--sw-err);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 4px;
}
.smm-del:hover {
  background: color-mix(in srgb, var(--sw-err) 15%, transparent);
}
.smm-del:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.smm-empty {
  margin: 0;
  font-size: 12px;
  color: var(--sw-fg-2);
}
</style>
