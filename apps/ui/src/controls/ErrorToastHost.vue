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
/**
 * Failures the operator caused, shown where they are looking.
 *
 * These answer something just DONE — an expansion that found nothing, a save
 * that was refused — so they appear immediately and leave on their own. Three
 * details separate a usable toast from one people learn to ignore:
 *
 * - **It says how long it has left.** A bar that drains is the difference
 *   between "it vanished before I read it" and "I could see it going".
 * - **Attention stops the clock.** Hovering or tabbing in holds it open; a
 *   message that expires while being read is worse than none.
 * - **It can be opened.** The summary is one line; the request and the
 *   response body are a click away, so a toast can be acted on rather than
 *   just noticed.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import ErrorRecordCard from './ErrorRecordCard.vue';
import { useErrorCenterStore } from './errorCenter';

const LIFETIME_MS = 5000;
/** How often the bar advances. 50ms is imperceptibly smooth and cheap. */
const TICK_MS = 50;

const { t } = useI18n({ useScope: 'global' });
const center = useErrorCenterStore();

/** Per-toast milliseconds remaining. Held, not reset, while paused — pausing
 *  is "stop the clock", not "start again". */
const remaining = ref<Record<string, number>>({});
const paused = ref<Record<string, boolean>>({});
const expanded = ref<string | null>(null);
/**
 * Where focus was before a toast took it.
 *
 * A toast appears beside whatever the operator was doing, and dismissing it
 * with Esc should put them back there rather than at the top of the document —
 * a keyboard user who loses their place has to tab all the way back to it.
 */
let focusBeforeToast: HTMLElement | null = null;
/**
 * Captured when a toast APPEARS, not when it takes focus.
 *
 * Reading `document.activeElement` on `focusin` was too late: the focus update
 * steps set the active element BEFORE the event fires, so by then it is
 * already the toast and the "not inside the host" guard never passed. Nothing
 * was ever captured, and Esc restored nothing.
 */
function rememberFocus(): void {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (active instanceof HTMLElement && !active.closest('.toast-host')) focusBeforeToast = active;
}
function restoreFocus(): void {
  const back = focusBeforeToast;
  focusBeforeToast = null;
  if (back && back.isConnected) back.focus();
}

let timer: ReturnType<typeof setInterval> | null = null;
function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
function startTimer(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    for (const toast of center.toasts) {
      // An expanded toast is being read: it stays until dismissed.
      if (paused.value[toast.id] || expanded.value === toast.id) continue;
      const left = (remaining.value[toast.id] ?? LIFETIME_MS) - TICK_MS;
      if (left <= 0) center.dismissToast(toast.id);
      else remaining.value = { ...remaining.value, [toast.id]: left };
    }
    if (center.toasts.length === 0) stopTimer();
  }, TICK_MS);
}

watch(
  () => center.toasts.map((x) => x.id).join(','),
  (ids, prev) => {
    // A toast has just arrived: whatever the operator was on is what Esc
    // should return them to.
    if (ids && (!prev || ids.length > prev.length)) rememberFocus();
    for (const toast of center.toasts) {
      if (remaining.value[toast.id] === undefined) {
        remaining.value = { ...remaining.value, [toast.id]: LIFETIME_MS };
      }
    }
    if (center.toasts.length > 0) startTimer();
    else stopTimer();
  },
  { immediate: true },
);
onBeforeUnmount(stopTimer);

function pct(id: string): number {
  return Math.max(0, Math.min(100, ((remaining.value[id] ?? LIFETIME_MS) / LIFETIME_MS) * 100));
}
function toggle(id: string): void {
  expanded.value = expanded.value === id ? null : id;
}
function close(id: string): void {
  if (expanded.value === id) expanded.value = null;
  center.dismissToast(id);
  restoreFocus();
}
function onKeydown(id: string, ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    close(id);
    return;
  }
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    toggle(id);
  }
}
const hasToasts = computed(() => center.toasts.length > 0);
</script>

<template>
  <!-- `alert` rather than `status`: these announce a failure and should
       interrupt a screen reader rather than wait for a pause. -->
  <div v-if="hasToasts" class="toast-host" role="alert" aria-live="assertive">
    <transition-group name="toast">
      <div
        v-for="toast in center.toasts"
        :key="toast.id"
        class="toast"
        tabindex="0"
        @mouseenter="paused[toast.id] = true"
        @mouseleave="paused[toast.id] = false"
        @focusin="paused[toast.id] = true"
        @focusout="paused[toast.id] = false"
        @click="toggle(toast.id)"
        @keydown="onKeydown(toast.id, $event)"
      >
        <button type="button" class="toast-close" :title="t('Dismiss')" @click.stop="close(toast.id)">
          <Icon name="close" :size="10" />
        </button>
        <ErrorRecordCard :record="toast" :expanded="expanded === toast.id" @toggle="toggle(toast.id)" />
        <div class="toast-bar"><div class="toast-bar-fill" :style="{ width: `${pct(toast.id)}%` }" /></div>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 340px;
  max-width: calc(100vw - 32px);
}
.toast {
  position: relative;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
  cursor: pointer;
  overflow: hidden;
}
.toast:focus-visible {
  outline: 1px solid var(--sw-accent);
  outline-offset: 1px;
}
.toast-close {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 1;
  background: none;
  border: none;
  padding: 2px;
  color: var(--sw-fg-2);
  cursor: pointer;
  line-height: 0;
}
.toast-close:hover {
  color: var(--sw-fg-1);
}
.toast-bar {
  height: 2px;
  background: var(--sw-bg-2);
}
.toast-bar-fill {
  height: 100%;
  background: var(--sw-danger, #e5534b);
  transition: width 50ms linear;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
</style>
