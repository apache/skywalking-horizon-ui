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
  Locale picker. Mounted in both the topbar (post-auth) and the
  login page (pre-auth). Pre-auth `pick()` stops at `setLocale`;
  the BFF-state refresh would 401 and the 401 handler patches
  Pinia auth state, masking the chrome switch.

  The menu is teleported to <body> — its in-flow position would
  otherwise sit inside the login page's `.top` stacking context,
  which `.center` (the form column, same z-index, later in
  document order) covers. Clicks on dropdown items would land on
  the form instead of the menu.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import Icon from '@/components/icons/Icon.vue';
import { SUPPORTED_LOCALES, LOCALE_NATIVE_LABEL, setLocale, i18n, type Locale } from '@/i18n';
import { refreshConfigBundle } from '@/controls/configBundle';
import { useAuthStore } from '@/state/auth';

const auth = useAuthStore();
const queryClient = useQueryClient();
const locale = computed<Locale>(() => i18n.global.locale.value as Locale);
const tLanguage = computed<string>(() => i18n.global.t('Language'));

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const buttonEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuPos = ref<{ top: number; right: number }>({ top: 0, right: 0 });

function recomputeMenuPos(): void {
  const btn = buttonEl.value;
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  menuPos.value = { top: rect.bottom + 6, right: window.innerWidth - rect.right };
}

watch(open, async (isOpen) => {
  if (!isOpen) return;
  await nextTick();
  recomputeMenuPos();
});

function toggle(e: Event): void {
  e.stopPropagation();
  open.value = !open.value;
}

async function pick(next: Locale, e: Event): Promise<void> {
  e.stopPropagation();
  open.value = false;
  if (next === locale.value) return;
  // Flipping the locale re-renders every component that calls `t()`
  // (sidebar / topbar / banners / dashboards — 100+ subscribers). That
  // reactivity cascade runs on the main thread; if we trigger it on
  // the same tick as the menu-close, Vue batches DOM updates and the
  // menu visibly stays open until the cascade finishes. Yield one
  // animation frame so the browser paints the closed menu first,
  // then take the hit.
  await nextTick();
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await setLocale(next);
  if (!auth.isAuthenticated) return;
  // Bundle refetch + query invalidation run in the background — the
  // locale change is already visible from `setLocale`'s reactivity,
  // and the new bundle just refreshes the dashboard chrome strings.
  void refreshConfigBundle().catch(() => {});
  void queryClient.invalidateQueries();
}

function onDocClick(e: MouseEvent): void {
  if (!open.value) return;
  const target = e.target as Node;
  const inside =
    (rootEl.value && rootEl.value.contains(target)) ||
    (menuEl.value && menuEl.value.contains(target));
  if (!inside) open.value = false;
}

function onWindowChange(): void {
  if (open.value) recomputeMenuPos();
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
  window.addEventListener('resize', onWindowChange);
  window.addEventListener('scroll', onWindowChange, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  window.removeEventListener('resize', onWindowChange);
  window.removeEventListener('scroll', onWindowChange, true);
});
</script>

<template>
  <div ref="rootEl" class="locale-chip-cluster">
    <button
      ref="buttonEl"
      type="button"
      class="sw-btn locale-chip"
      :title="tLanguage"
      :aria-label="tLanguage"
      @click="toggle"
    >
      <Icon name="web" :size="14" />
      <span class="locale-chip-label">{{ LOCALE_NATIVE_LABEL[locale] }}</span>
      <Icon name="caret" :size="10" />
    </button>
    <Teleport to="body">
      <ul
        v-if="open"
        ref="menuEl"
        class="locale-menu"
        role="menu"
        :style="{ top: menuPos.top + 'px', right: menuPos.right + 'px' }"
      >
        <li class="locale-menu-head">{{ tLanguage }}</li>
        <!-- English on top, separated from the alphabetical block
             below. SUPPORTED_LOCALES is authored in that order; we
             just render the divider after the first item. -->
        <template v-for="(loc, i) in SUPPORTED_LOCALES" :key="loc">
          <li class="locale-menu-sep" v-if="i === 1" role="separator" aria-hidden="true" />
          <li
            :class="{ on: locale === loc }"
            role="menuitem"
            @click="pick(loc, $event)"
          >
            {{ LOCALE_NATIVE_LABEL[loc] }}
          </li>
        </template>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.locale-chip-cluster {
  position: relative;
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
  cursor: pointer;
}
.locale-chip:hover { color: var(--sw-fg-1); }
.locale-chip-label { white-space: nowrap; }
</style>

<style>
.locale-menu {
  position: fixed;
  z-index: 1000;
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
  cursor: default;
}
.locale-menu li:not(.locale-menu-head):not(.locale-menu-sep) {
  padding: 6px 12px;
  font-size: 12.5px;
  color: var(--sw-fg-2);
  cursor: pointer;
  user-select: none;
}
.locale-menu li:not(.locale-menu-head):not(.locale-menu-sep):hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
}
.locale-menu-sep {
  height: 1px;
  margin: 4px 8px;
  padding: 0;
  background: var(--sw-line-2);
  list-style: none;
  pointer-events: none;
}
.locale-menu li.on { color: var(--sw-accent); font-weight: 500; }
</style>
