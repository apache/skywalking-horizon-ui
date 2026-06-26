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
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';

/** The 3D Infra Map entry pill lives in the topbar on every page. It
 *  stays compact ("3D Infra") by default and expands to the full
 *  "3D Infrastructure Map" wordmark ONLY on hover — including
 *  while the operator is on /3d/map itself. The 3D route already
 *  collapses the sidebar to give the canvas every horizontal pixel;
 *  keeping the topbar pill compact in 3D mode matches that intent
 *  (any extra topbar real estate should also belong to the 3D view).
 *
 *  We track hover in Vue rather than via CSS `:hover` because the
 *  v-if content swap below has to know about hover to decide which
 *  form to render — an inline-block + max-width transition on a
 *  nested span renders the "hidden" text as a stray fragment during
 *  the transition (sub-baseline, wrong size), which was the visual
 *  bug we chased earlier. The v-if swap is mount/unmount, stable. */
const exp3dHover = ref(false);
const exp3dExpanded = computed<boolean>(() => exp3dHover.value);
</script>

<template>
  <!-- The stacked-tier icon mirrors the page's three planes (apps /
       mesh / infra) using the same tint colors, so the pill reads as a
       microcosm of the view it leads to. -->
  <RouterLink
    to="/3d/map"
    class="exp-badge"
    :class="{ 'is-on': exp3dExpanded }"
    aria-label="3D Infra Map"
    @mouseenter="exp3dHover = true"
    @mouseleave="exp3dHover = false"
  >
    <svg class="exp-icon" viewBox="0 0 24 26" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="expTierApps" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#fb923c" />
          <stop offset="100%" stop-color="#f97316" />
        </linearGradient>
        <linearGradient id="expTierMesh" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#c084fc" />
          <stop offset="100%" stop-color="#a855f7" />
        </linearGradient>
        <linearGradient id="expTierInfra" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#4ade80" />
          <stop offset="100%" stop-color="#22c55e" />
        </linearGradient>
      </defs>
      <path d="M12 2 L21 6 L12 10 L3 6 Z" fill="url(#expTierApps)" />
      <path d="M12 6 L21 10 L12 14 L3 10 Z" fill="url(#expTierApps)" opacity="0.18" />
      <path d="M12 9 L21 13 L12 17 L3 13 Z" fill="url(#expTierMesh)" />
      <path d="M12 13 L21 17 L12 21 L3 17 Z" fill="url(#expTierMesh)" opacity="0.18" />
      <path d="M12 16 L21 20 L12 24 L3 20 Z" fill="url(#expTierInfra)" />
    </svg>
    <span class="exp-name">{{ exp3dExpanded ? '3D Infrastructure Map' : '3D Infra' }}</span>
  </RouterLink>
</template>

<style scoped>
/* Width changes naturally with the rendered text (v-if swap is instant);
 * only border/glow/background transition so the emphasis lands on the
 * focal state. See <script> for why the swap is v-if, not a CSS width
 * transition. */
.exp-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  margin-left: 10px;
  padding: 0 11px 0 7px;
  border-radius: 16px;
  background: rgba(20, 14, 28, 0.78);
  border: 1px solid rgba(249, 115, 22, 0.5);
  color: var(--sw-fg-0);
  text-decoration: none;
  user-select: none;
  position: relative;
  transition:
    border-color 200ms ease,
    background 220ms ease,
    box-shadow 240ms ease;
}
.exp-badge:hover,
.exp-badge.is-on {
  border-color: rgba(249, 115, 22, 0.95);
  background: rgba(28, 18, 36, 0.95);
  box-shadow:
    0 0 0 1px rgba(249, 115, 22, 0.15),
    0 6px 18px -8px rgba(249, 115, 22, 0.55);
}
.exp-icon {
  width: 16px;
  height: 18px;
  flex: 0 0 16px;
  filter:
    drop-shadow(0 0 3px rgba(168, 85, 247, 0.4))
    drop-shadow(0 0 3px rgba(249, 115, 22, 0.3));
}
.exp-name {
  font-size: 11.5px;
  font-weight: 700;
  color: #f5f3ff;
  letter-spacing: 0.01em;
  white-space: nowrap;
  line-height: 1;
}
</style>
