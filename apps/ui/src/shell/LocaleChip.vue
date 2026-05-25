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
  as the theme chip.

  Outside-click closes the menu via a document-level listener (not
  `focusout`). The earlier `focusout`-based pattern was unreliable
  on the pre-auth login page: clicking a non-focusable `<li>` could
  fire focusout in some browser/race combinations BEFORE the click
  reached the `<li>`, removing the element from the DOM and
  cancelling the click. The document-click pattern is symmetrical
  for inside vs outside and always fires after the inside click.

  `locale` and `t` are read straight off `i18n.global` rather than
  through `useI18n()` so reactivity always tracks the global state
  regardless of how the surrounding component is scoped. This
  matters when the same component is mounted both pre-auth (no
  parent supplying scope) and post-auth (inside AppShell).
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
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

function toggle(e: Event): void {
  e.stopPropagation();
  open.value = !open.value;
  // eslint-disable-next-line no-console
  console.log('[LocaleChip] toggle, open=', open.value, 'locale=', locale.value);
}

async function pick(next: Locale, e: Event): Promise<void> {
  e.stopPropagation();
  // eslint-disable-next-line no-console
  console.log('[LocaleChip] pick CLICKED', next, 'current=', locale.value);
  open.value = false;
  if (next === locale.value) {
    // eslint-disable-next-line no-console
    console.log('[LocaleChip] same locale, early return');
    return;
  }
  // Synchronous chrome flip — this MUST succeed regardless of auth.
  await setLocale(next);
  // eslint-disable-next-line no-console
  console.log('[LocaleChip] after setLocale, locale=', locale.value, 'i18n.global=', i18n.global.locale.value);
  // Server-state refresh only when authenticated. On the pre-auth
  // login page the BFF returns 401, which fires
  // `bffClient.handleUnauthorized()` → `auth.$patch({user: null})`
  // — touching Pinia auth state for no good reason and (depending on
  // surrounding subscribers) potentially re-rendering the LoginView
  // in a way that masks the chrome locale switch. Just skip it.
  if (!auth.isAuthenticated) {
    // eslint-disable-next-line no-console
    console.log('[LocaleChip] not authenticated, skipping BFF refresh');
    return;
  }
  try {
    await refreshConfigBundle();
  } catch {
    /* BFF down — chrome still switched */
  }
  void queryClient.invalidateQueries();
}

function onDocClick(e: MouseEvent): void {
  if (!open.value) return;
  if (!rootEl.value || !rootEl.value.contains(e.target as Node)) {
    open.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
});
</script>

<template>
  <div ref="rootEl" class="locale-chip-cluster">
    <button
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
    <ul v-if="open" class="locale-menu" role="menu">
      <li class="locale-menu-head">{{ tLanguage }}</li>
      <li
        v-for="loc in SUPPORTED_LOCALES"
        :key="loc"
        :class="{ on: locale === loc }"
        role="menuitem"
        @click="pick(loc, $event)"
      >
        {{ LOCALE_NATIVE_LABEL[loc] }}
      </li>
    </ul>
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
.locale-chip-label {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.locale-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
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
.locale-menu li:not(.locale-menu-head) {
  padding: 6px 12px;
  font-size: 12.5px;
  color: var(--sw-fg-2);
  cursor: pointer;
  user-select: none;
}
.locale-menu li:not(.locale-menu-head):hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
}
.locale-menu li.on { color: var(--sw-accent); font-weight: 500; }
</style>
