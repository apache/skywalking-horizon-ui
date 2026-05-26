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
  Floating panel positioned relative to a click point (preferred) or a
  fallback anchor element. Teleported to <body> so it escapes any
  clipping ancestor; viewport-clamped so it stays fully visible.
  Closes on outside click or Esc.

  When `point` is provided, the panel opens at that screen coordinate
  (typically the mouse click). The `anchor` element is still used for
  outside-click detection so a second click on the same widget closes
  the panel cleanly.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, nextTick } from 'vue';

const props = defineProps<{
  open: boolean;
  anchor: HTMLElement | null;
  /** Screen-coordinate origin for the panel — usually the mouse click. */
  point?: { x: number; y: number } | null;
  /** Max panel width in px. Default 520. */
  width?: number;
}>();

const emit = defineEmits<{ close: [] }>();

const panel = ref<HTMLElement | null>(null);
const pos = ref<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: props.width ?? 520 });

function reposition(): void {
  const margin = 8;
  const wantedW = Math.min(props.width ?? 520, window.innerWidth - margin * 2);
  // Cap measured height at the viewport — the panel's own max-height
  // clamps it; we plan around the clamped value, never around the
  // pre-clamp scroll-height.
  const ph = Math.min(
    panel.value?.offsetHeight ?? 280,
    window.innerHeight - margin * 2,
  );

  // Origin: prefer the click point, fall back to anchor center.
  let originX: number;
  let originY: number;
  if (props.point) {
    originX = props.point.x;
    originY = props.point.y;
  } else if (props.anchor) {
    const r = props.anchor.getBoundingClientRect();
    originX = (r.left + r.right) / 2;
    originY = (r.top + r.bottom) / 2;
  } else {
    originX = window.innerWidth / 2;
    originY = window.innerHeight / 2;
  }

  // Horizontal: prefer right-of-cursor, flip left if no room, clamp.
  let left = originX + 12;
  if (left + wantedW > window.innerWidth - margin) left = originX - wantedW - 12;
  if (left < margin) left = margin;
  if (left + wantedW > window.innerWidth - margin) left = window.innerWidth - wantedW - margin;

  // Vertical: prefer below-cursor; flip above if not enough room;
  // pin to top margin if neither side fits (panel scrolls internally).
  const spaceBelow = window.innerHeight - margin - (originY + 12);
  const spaceAbove = originY - 12 - margin;
  let top: number;
  if (ph <= spaceBelow) {
    top = originY + 12;
  } else if (ph <= spaceAbove) {
    top = originY - 12 - ph;
  } else {
    top = margin;
  }

  pos.value = { top, left, width: wantedW };
}

function onDocClick(e: MouseEvent): void {
  if (!props.open) return;
  if (panel.value?.contains(e.target as Node)) return;
  if (props.anchor?.contains(e.target as Node)) return;
  emit('close');
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) emit('close');
}
function onResize(): void {
  if (props.open) reposition();
}

let panelObserver: ResizeObserver | null = null;
function observePanel(): void {
  panelObserver?.disconnect();
  if (!panel.value) return;
  panelObserver = new ResizeObserver(() => reposition());
  panelObserver.observe(panel.value);
}

watch(
  () => [props.open, props.anchor, props.point],
  async ([isOpen]) => {
    if (!isOpen) {
      panelObserver?.disconnect();
      panelObserver = null;
      return;
    }
    await nextTick();
    reposition();
    observePanel();
  },
  { immediate: true },
);

document.addEventListener('click', onDocClick);
document.addEventListener('keydown', onKey);
window.addEventListener('resize', onResize);
window.addEventListener('scroll', onResize, true);

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('scroll', onResize, true);
  panelObserver?.disconnect();
});

const style = computed<Record<string, string>>(() => ({
  top: `${pos.value.top}px`,
  left: `${pos.value.left}px`,
  width: `${pos.value.width}px`,
}));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="panel" class="fpa" :style="style" role="dialog">
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.fpa {
  position: fixed;
  z-index: 1100;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.55);
  max-height: calc(100vh - 16px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
