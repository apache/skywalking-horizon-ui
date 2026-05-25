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
  Shared banner for the three template-admin pages (overview, layer,
  alert-page). Renders the page-level edit-mode state in one strip:

    UNREACHABLE — red strip, big "READ-ONLY" label, no edits possible.
    DIVERGED    — amber strip, summary of how many rows differ from OAP.
    CLEAN       — green strip, quiet acknowledgement.

  Composables drive the content; this component is dumb display.
-->
<script setup lang="ts">
import { ref } from 'vue';
import { bff } from '@/api/client';
import { refreshConfigBundle } from '@/controls/configBundle';
import type { SyncBanner } from './useTemplateSync';

defineProps<{ banner: SyncBanner }>();
const emit = defineEmits<{ resolved: [] }>();

const resolving = ref(false);
const resolveErr = ref<string | null>(null);

async function onResolve(): Promise<void> {
  if (resolving.value) return;
  resolving.value = true;
  resolveErr.value = null;
  try {
    await bff.templateSync.resolveConflicts();
    // Pull the fresh bundle so the banner clears + the parent page's
    // sync-derived state (badges, conflict counts) all update at once.
    await refreshConfigBundle({ force: true });
    emit('resolved');
  } catch (err) {
    resolveErr.value = err instanceof Error ? err.message : String(err);
  } finally {
    resolving.value = false;
  }
}
</script>

<template>
  <div class="sbb" :class="`sbb--${banner.severity}`" role="status">
    <div class="sbb__row">
      <span class="sbb__chip">{{ chipLabel(banner.severity) }}</span>
      <div class="sbb__text">
        <div class="sbb__msg">{{ banner.message }}</div>
        <div v-if="banner.detail" class="sbb__detail">{{ banner.detail }}</div>
        <div v-if="resolveErr" class="sbb__err">{{ resolveErr }}</div>
      </div>
      <button
        v-if="banner.severity === 'conflict'"
        type="button"
        class="sbb__action"
        :disabled="resolving"
        @click="onResolve"
      >{{ resolving ? 'Resolving…' : 'Disable extras' }}</button>
    </div>
  </div>
</template>

<script lang="ts">
function chipLabel(s: SyncBanner['severity']): string {
  switch (s) {
    case 'unreachable':
      return 'READ-ONLY';
    case 'conflict':
      return 'CONFLICT';
    case 'diverged':
      return 'EDIT MODE';
    case 'clean':
      return 'EDIT MODE';
    default:
      return '…';
  }
}
export default { chipLabel };
</script>

<style scoped>
.sbb {
  border: 1px solid var(--sw-border, #2a2f38);
  border-radius: 4px;
  padding: 8px 12px;
  margin: 0 0 12px 0;
  background: var(--sw-bg-elev, #161a20);
  font-size: 12px;
  line-height: 1.45;
}
.sbb--unreachable {
  border-color: var(--sw-danger, #c0392b);
  background: rgba(192, 57, 43, 0.08);
}
.sbb--conflict {
  border-color: var(--sw-danger, #c0392b);
  background: rgba(192, 57, 43, 0.06);
}
.sbb--diverged {
  border-color: var(--sw-warn, #b88500);
  background: rgba(184, 133, 0, 0.08);
}
.sbb--clean {
  border-color: var(--sw-ok, #2e7d4e);
  background: rgba(46, 125, 78, 0.06);
}
.sbb--unknown {
  border-color: var(--sw-muted, #4a525c);
  background: var(--sw-bg-elev, #161a20);
}
.sbb__row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.sbb__chip {
  flex: 0 0 auto;
  font-weight: 600;
  letter-spacing: 0.05em;
  font-size: 10px;
  padding: 3px 8px;
  border-radius: 3px;
  text-transform: uppercase;
  color: var(--sw-text-strong, #e8edf2);
  background: rgba(255, 255, 255, 0.06);
  white-space: nowrap;
}
.sbb--unreachable .sbb__chip { background: var(--sw-danger, #c0392b); color: #fff; }
.sbb--conflict .sbb__chip    { background: var(--sw-danger, #c0392b); color: #fff; }
.sbb--diverged .sbb__chip    { background: var(--sw-warn, #b88500); color: #1a1a1a; }
.sbb--clean .sbb__chip       { background: var(--sw-ok, #2e7d4e); color: #fff; }
.sbb__text {
  flex: 1 1 auto;
  min-width: 0;
}
.sbb__msg {
  color: var(--sw-text-strong, #e8edf2);
}
.sbb__detail {
  margin-top: 2px;
  color: var(--sw-text-muted, #8a93a0);
  font-size: 11px;
}
.sbb__err {
  margin-top: 4px;
  color: var(--sw-danger, #c0392b);
  font-size: 11px;
}
.sbb__action {
  flex: 0 0 auto;
  align-self: center;
  background: var(--sw-danger, #c0392b);
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.sbb__action:disabled {
  opacity: 0.5;
  cursor: wait;
}
</style>
