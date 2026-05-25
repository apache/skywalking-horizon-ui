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
  Locale picker chip. Used in both the topbar (post-auth) and the
  login page (pre-auth) — same component, same styling vocabulary
  as the theme chip. Locale picks are persisted to localStorage and
  immediately propagate:
    - vue-i18n's active locale switches (English chrome → translated chrome).
    - vue-query caches are invalidated so BFF-localized payloads
      (sidebar menu, layer templates, overviews) refetch in the new
      locale on the next interaction.
  The native-script label is always shown (中文, 日本語, …) so the operator
  can find their language regardless of which locale is currently
  active. Closing on outside-blur matches the theme chip's behavior.
-->
<script setup lang="ts">
import { ref } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import { SUPPORTED_LOCALES, LOCALE_NATIVE_LABEL, setLocale, type Locale } from '@/i18n';
import { refreshConfigBundle } from '@/controls/configBundle';

const { t, locale } = useI18n();
const queryClient = useQueryClient();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

function toggle(): void {
  open.value = !open.value;
}

async function pick(next: Locale): Promise<void> {
  open.value = false;
  if (next === locale.value) return;
  const applied = await setLocale(next);
  if (applied !== next) return; // load failed; setLocale already logged
  // Server-rendered text is keyed by the locale header. Two refresh
  // paths because two stores hold it:
  //   1. The configBundle (custom state + localStorage cache for
  //      layer / overview dashboards) — explicit refresh, since its
  //      etag would otherwise serve the cached pre-switch payload.
  //   2. vue-query consumers (sidebar menu, alarms, feature pages) —
  //      invalidate fires every active query through its normal
  //      refetch path with the new X-Horizon-Locale header.
  await refreshConfigBundle();
  void queryClient.invalidateQueries();
}

function onBlur(e: FocusEvent): void {
  const next = e.relatedTarget as HTMLElement | null;
  if (!rootEl.value?.contains(next)) open.value = false;
}
</script>

<template>
  <div ref="rootEl" class="locale-chip-cluster" tabindex="-1" @focusout="onBlur">
    <button
      type="button"
      class="sw-btn locale-chip"
      :title="t('Language')"
      :aria-label="t('Language')"
      @click="toggle"
    >
      <Icon name="web" :size="14" />
      <span class="locale-chip-label">{{ LOCALE_NATIVE_LABEL[locale as Locale] }}</span>
      <Icon name="caret" :size="10" />
    </button>
    <transition name="rf-menu">
      <ul v-if="open" class="locale-menu">
        <li class="locale-menu-head">{{ t('Language') }}</li>
        <li
          v-for="loc in SUPPORTED_LOCALES"
          :key="loc"
          :class="{ on: locale === loc }"
          @click="pick(loc)"
        >
          {{ LOCALE_NATIVE_LABEL[loc] }}
        </li>
      </ul>
    </transition>
  </div>
</template>

<style scoped>
.locale-chip-cluster {
  position: relative;
  outline: none;
}
.locale-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
}
.locale-chip:hover { color: var(--sw-fg-1); }
.locale-chip-label {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.locale-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 50;
  min-width: 168px;
  margin: 0;
  padding: 6px 0;
  list-style: none;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
}
.locale-menu-head {
  padding: 4px 12px;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.locale-menu li:not(.locale-menu-head) {
  padding: 6px 12px;
  font-size: 12.5px;
  color: var(--sw-fg-2);
  cursor: pointer;
}
.locale-menu li:not(.locale-menu-head):hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
}
.locale-menu li.on { color: var(--sw-accent); font-weight: 500; }

.rf-menu-enter-active, .rf-menu-leave-active { transition: opacity 0.12s, transform 0.12s; }
.rf-menu-enter-from, .rf-menu-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
