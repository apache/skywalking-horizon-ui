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
<script setup lang="ts">
import { ref } from 'vue';
import Icon from '@/components/icons/Icon.vue';
import { useThemeStore, AVAILABLE_THEMES, type ThemeId } from '@/state/theme';

// Per-user theme chip — opens a popover with the 5 bundled themes +
// an option to clear the local override and fall back to the org
// default. Lives in the topbar's right cluster, next to alarm badge.
// Per CLAUDE.md the theme is a runtime concern, not a feature flag;
// this is the only surface where end users touch it.
const themeStore = useThemeStore();
const themeMenuOpen = ref(false);
const themeChipEl = ref<HTMLElement | null>(null);
function toggleThemeMenu(): void { themeMenuOpen.value = !themeMenuOpen.value; }
function pickTheme(id: ThemeId): void {
  themeStore.setUserOverride(id);
  themeMenuOpen.value = false;
}
function resetThemeOverride(): void {
  themeStore.clearUserOverride();
  themeMenuOpen.value = false;
}
function onThemeChipBlur(e: FocusEvent): void {
  // Close when focus leaves the cluster — the popover lives outside
  // the chip, so we check `relatedTarget` for cluster containment.
  const next = e.relatedTarget as HTMLElement | null;
  if (!themeChipEl.value?.contains(next)) themeMenuOpen.value = false;
}
</script>

<template>
  <!-- The small dot indicates an active user override (theme differs
       from org default). -->
  <div ref="themeChipEl" class="theme-chip-cluster" tabindex="-1" @focusout="onThemeChipBlur">
    <button
      type="button"
      class="sw-btn theme-chip"
      :title="`Theme: ${themeStore.active}${themeStore.hasUserOverride ? ' (your override)' : ''} — click to change`"
      @click="toggleThemeMenu"
    >
      <span class="theme-chip-swatch" />
      <span class="theme-chip-label">{{ themeStore.active }}</span>
      <span v-if="themeStore.hasUserOverride" class="theme-chip-dot" />
      <Icon name="caret" :size="10" />
    </button>
    <transition name="rf-menu">
      <ul v-if="themeMenuOpen" class="theme-menu">
        <li class="theme-menu-head">Theme</li>
        <li
          v-for="t in AVAILABLE_THEMES"
          :key="t.id"
          :class="{ on: themeStore.active === t.id }"
          @click="pickTheme(t.id)"
        >
          {{ t.label }}
          <span v-if="!themeStore.hasUserOverride && t.id === themeStore.active" class="theme-menu-org">(org default)</span>
        </li>
        <li
          v-if="themeStore.hasUserOverride"
          class="theme-menu-reset"
          @click="resetThemeOverride"
        >Reset to org default</li>
      </ul>
    </transition>
  </div>
</template>

<style scoped>
/* Mirrors `refresh-cluster` — a small icon button + popover. */
.theme-chip-cluster {
  position: relative;
  display: inline-flex;
  outline: none;
}
.theme-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 8px;
  height: 26px;
}
.theme-chip-swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--sw-accent);
  border: 1px solid var(--sw-line-2);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
}
.theme-chip-label {
  font-size: 11px;
  color: var(--sw-fg-1);
  text-transform: capitalize;
  letter-spacing: 0.02em;
}
.theme-chip-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--sw-accent);
  border: 1px solid var(--sw-bg-0);
}
.theme-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  padding: 4px 0;
  margin: 0;
  list-style: none;
  min-width: 200px;
  z-index: 60;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}
.theme-menu-head {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
  padding: 4px 10px 6px;
  border-bottom: 1px solid var(--sw-line);
}
.theme-menu li:not(.theme-menu-head) {
  padding: 6px 10px;
  font-size: 11.5px;
  color: var(--sw-fg-1);
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.theme-menu li:not(.theme-menu-head):hover {
  background: var(--sw-bg-3);
}
.theme-menu li.on { color: var(--sw-accent); font-weight: 500; }
.theme-menu-org { color: var(--sw-fg-3); font-size: 10.5px; }
.theme-menu-reset {
  border-top: 1px solid var(--sw-line);
  color: var(--sw-fg-2);
  font-size: 10.5px !important;
}

/* Popover transition (shared `rf-menu` name, kept local to the chip). */
.rf-menu-enter-from, .rf-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.rf-menu-enter-active, .rf-menu-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
</style>
