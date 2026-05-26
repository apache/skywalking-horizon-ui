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
  Shown only while a page is in `?mode=preview` — tells the operator that
  the dashboard they're looking at is rendered from an UNPUBLISHED source
  (their local draft / bundled default / remote), not the normal live view.
  Dismissible (× button or Esc); re-appears when the previewed target
  changes so each dashboard surfaces the notice once.
-->
<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import Icon from '@/components/icons/Icon.vue';
import { usePreviewMode, getPreviewSource } from '@/controls/previewMode';
import { useLayers } from '@/shell/useLayers';
import { useConfigBundle } from '@/controls/configBundle';

const { t } = useI18n({ useScope: 'global' });
const route = useRoute();
const previewMode = usePreviewMode();
const { layers } = useLayers();
const { bundle } = useConfigBundle();

/** Friendly name of the dashboard being previewed (layer name / overview
 *  title), from the current route. */
const target = computed<string | null>(() => {
  const lm = route.path.match(/^\/layer\/([^/]+)/);
  if (lm) {
    const key = lm[1]!;
    return layers.value.find((l) => l.key.toLowerCase() === key.toLowerCase())?.name || key.toUpperCase();
  }
  const om = route.path.match(/^\/overview\/([^/]+)/);
  if (om) {
    const id = om[1]!;
    return (bundle.value?.overviews ?? []).find((o) => o.id === id)?.title || id;
  }
  return null;
});
const source = computed<string>(() => getPreviewSource() ?? 'local');

const dismissed = ref(false);
const show = computed(() => previewMode.value && !dismissed.value && !!target.value);
// Surface the notice once per previewed target — re-show when it changes.
watch([target, source], () => (dismissed.value = false));

function close(): void {
  dismissed.value = true;
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && show.value) close();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div v-if="show" class="preview-banner" role="status">
    <Icon name="event" :size="13" />
    <span class="preview-banner-text">
      <b>{{ t('Preview mode') }}</b> — <b>{{ target }}</b> {{ t('is loaded from your') }} <b>{{ source }}</b> {{ t('version, not the published one. Only you see this; everyone else gets the live (remote) dashboard.') }}
    </span>
    <button class="preview-banner-close" type="button" :title="t('Close (Esc)')" :aria-label="t('Close')" @click="close">✕</button>
  </div>
</template>

<style scoped>
.preview-banner {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 10px 14px 0;
  padding: 7px 12px;
  border: 1px solid var(--sw-accent-line, var(--sw-accent));
  background: var(--sw-accent-soft);
  border-radius: 7px;
  font-size: 12px;
  color: var(--sw-fg-1);
}
.preview-banner :deep(svg) { color: var(--sw-accent); flex: 0 0 auto; }
.preview-banner-text { flex: 1; line-height: 1.45; }
.preview-banner-text b { color: var(--sw-fg-0); }
.preview-banner-close {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  background: transparent;
  border: none;
  border-radius: 5px;
  color: var(--sw-fg-3);
  font-size: 12px;
  cursor: pointer;
}
.preview-banner-close:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
</style>
