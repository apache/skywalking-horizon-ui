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
  Tiny ⓘ widget-tip chip with a real styled popover. The popover is
  teleported to <body> so it escapes any clipping ancestor (widget
  cards use `overflow: hidden` for the rounded-corner mask). Position
  is computed from the icon's bounding rect on hover / focus and
  clamped to the viewport so it never lands off-screen.

  Replaces the scattered `<span class="tip" :title="...">?</span>`
  pattern — the native browser `title` attribute is slow + unstyled,
  which read as "tip is broken" to operators.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';

defineProps<{ tip?: string | null }>();

const iconRef = ref<HTMLElement | null>(null);
const hover = ref(false);

const bubbleStyle = ref<Record<string, string>>({});
const arrowDown = ref(true);

function reposition(): void {
  const el = iconRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  // Cap the bubble width at min(260, viewport - 16). We can't measure
  // the bubble before it's rendered, so we plan around the cap.
  const margin = 8;
  const cap = Math.min(260, window.innerWidth - margin * 2);
  let cx = r.left + r.width / 2;
  // Clamp horizontally so the bubble's nominal half-width fits in
  // the viewport — translateX(-50%) centers it on `cx`.
  if (cx - cap / 2 < margin) cx = margin + cap / 2;
  if (cx + cap / 2 > window.innerWidth - margin) cx = window.innerWidth - margin - cap / 2;

  // Prefer above the icon; flip below if there's no room (icon near
  // the top of the viewport).
  const above = r.top > 80;
  arrowDown.value = above;
  bubbleStyle.value = above
    ? {
        left: `${cx}px`,
        top: `${r.top - 6}px`,
        transform: 'translate(-50%, -100%)',
        maxWidth: `${cap}px`,
      }
    : {
        left: `${cx}px`,
        top: `${r.bottom + 6}px`,
        transform: 'translateX(-50%)',
        maxWidth: `${cap}px`,
      };
}

function show(): void {
  reposition();
  hover.value = true;
}
function hide(): void {
  hover.value = false;
}

const showBubble = computed<boolean>(() => hover.value);
</script>

<template>
  <span
    v-if="tip && tip.trim().length > 0"
    ref="iconRef"
    class="wt"
    tabindex="0"
    :aria-label="tip"
    @mouseenter="show"
    @mouseleave="hide"
    @focus="show"
    @blur="hide"
  >
    <svg class="wt__icon" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" stroke-width="1" />
      <circle cx="6" cy="3.4" r="0.75" fill="currentColor" />
      <rect x="5.35" y="5" width="1.3" height="4" rx="0.5" fill="currentColor" />
    </svg>
    <Teleport to="body">
      <span
        v-if="showBubble"
        class="wt__bubble"
        :class="{ 'wt__bubble--below': !arrowDown }"
        :style="bubbleStyle"
        role="tooltip"
      >{{ tip }}</span>
    </Teleport>
  </span>
</template>

<style scoped>
.wt {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--sw-fg-3);
  cursor: help;
  flex: 0 0 auto;
  vertical-align: middle;
}
.wt:hover, .wt:focus-visible { color: var(--sw-accent); outline: none; }
.wt__icon { width: 12px; height: 12px; display: block; }
</style>

<style>
/* Unscoped — the bubble lives at <body> via <Teleport> so a scoped
   selector wouldn't match. */
.wt__bubble {
  position: fixed;
  z-index: 1200;
  background: var(--sw-bg-0);
  color: var(--sw-fg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  padding: 6px 9px;
  font-size: 11.5px;
  line-height: 1.45;
  font-weight: 400;
  letter-spacing: 0;
  white-space: normal;
  text-align: left;
  width: max-content;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  pointer-events: none;
}
.wt__bubble::after {
  content: '';
  position: absolute;
  left: 50%;
  margin-left: -4px;
  border: 4px solid transparent;
}
.wt__bubble:not(.wt__bubble--below)::after {
  top: 100%;
  border-top-color: var(--sw-line-2);
}
.wt__bubble.wt__bubble--below::after {
  bottom: 100%;
  border-bottom-color: var(--sw-line-2);
}
</style>
