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
// Topbar shell — a row of independent chips. Each chip is a
// self-contained sibling component that owns its own store wiring,
// popover lifecycle, and click-outside listener (see LocaleChip for
// the canonical pattern). This file owns only the layout + the brand
// shown when the sidebar is folded.
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useThemeStore, AVAILABLE_THEMES } from '@/state/theme';
import { useSidebar } from '@/controls/sidebar';
import InfraMapPill from '@/shell/InfraMapPill.vue';
import OapHealthChip from '@/shell/OapHealthChip.vue';
import ColdStageChip from '@/shell/ColdStageChip.vue';
import TimeRangeChip from '@/shell/TimeRangeChip.vue';
import AutoRefreshChip from '@/shell/AutoRefreshChip.vue';
import AlarmBadgeChip from '@/shell/AlarmBadgeChip.vue';
import ThemeChip from '@/shell/ThemeChip.vue';
import LocaleChip from '@/shell/LocaleChip.vue';
import logoSw from '@/assets/icons/logo-sw.svg?raw';

// When the sidebar is folded its wordmark is hidden; surface the brand
// (logo + name) here in the topbar's left zone instead.
const { collapsed: sidebarCollapsed } = useSidebar();
const logoSwBlue = logoSw.replace(/fill="#fff"/g, 'fill="#1368B3"');

// The brand wordmark flips to the blue logo under a light theme. The
// theme store is the only chrome-wide bit this shell still reads
// directly (the chips own everything else).
const themeStore = useThemeStore();
const isLightAppearance = computed<boolean>(
  () => AVAILABLE_THEMES.find((t) => t.id === themeStore.active)?.appearance === 'light',
);
</script>

<template>
  <header class="sw-top">
    <RouterLink v-if="sidebarCollapsed" to="/" class="top-brand" aria-label="SkyWalking Horizon">
      <span class="top-brand-logo" v-html="isLightAppearance ? logoSwBlue : logoSw" />
      <small>Horizon</small>
    </RouterLink>
    <InfraMapPill />
    <div class="sw-top-spacer" />
    <div class="sw-top-actions">
      <OapHealthChip />
      <ColdStageChip />
      <TimeRangeChip />
      <AutoRefreshChip />
      <AlarmBadgeChip />
      <ThemeChip />
      <!-- A locale pick invalidates every active vue-query so BFF-localized
           payloads (menu / layer dashboards / overviews) refetch in the
           new locale. -->
      <LocaleChip />
    </div>
  </header>
</template>

<style scoped>
/* Brand shown in the topbar's left zone only while the sidebar is
   folded — same wordmark + "Horizon" label as the sidebar header. */
.top-brand {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
  color: inherit;
}
.top-brand-logo { display: inline-flex; align-items: center; }
.top-brand-logo :deep(svg) { height: 16px; width: auto; display: block; }
.top-brand small {
  font-weight: 500;
  color: var(--sw-fg-2);
  margin-left: 4px;
  letter-spacing: 0.02em;
}
</style>
