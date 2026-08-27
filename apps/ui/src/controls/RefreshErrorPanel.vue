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
 * What the timer could not read, kept where the timer lives.
 *
 * A background failure has no audience at the moment it happens — nobody asked
 * for that round — so it waits beside the refresh button behind an unread
 * count instead of interrupting. The placement is the explanation: these are
 * the REFRESH's failures, hanging off the control that caused them.
 *
 * Five, newest first. During an outage every cycle fails and a longer list
 * only repeats itself; what an operator needs is "it is still failing, and
 * here is the last thing it said".
 */
import { onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import ErrorRecordCard from './ErrorRecordCard.vue';
import { useErrorCenterStore } from './errorCenter';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';

const { t } = useI18n({ useScope: 'global' });
const center = useErrorCenterStore();

const open = ref(false);
const expanded = ref<string | null>(null);
const rootEl = ref<HTMLElement | null>(null);

function toggleOpen(): void {
  open.value = !open.value;
  // Opening is reading. The records stay; only the badge clears.
  if (open.value) center.markRead();
}
function onOutside(ev: MouseEvent): void {
  if (!open.value) return;
  if (rootEl.value && !rootEl.value.contains(ev.target as Node)) open.value = false;
}
useEscapeToClose(
  () => open.value,
  () => {
    open.value = false;
  },
);
if (typeof window !== 'undefined') window.addEventListener('click', onOutside);
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('click', onOutside);
});
</script>

<template>
  <div v-if="center.refreshHistory.length > 0" ref="rootEl" class="rerr">
    <button
      type="button"
      class="sw-btn is-icon rerr-btn"
      :class="{ unread: center.hasUnread }"
      :title="t('{count} refresh failures', { count: center.refreshHistory.length })"
      :aria-expanded="open ? 'true' : 'false'"
      @click.stop="toggleOpen"
    >
      <Icon name="alert" :size="12" />
      <span v-if="center.hasUnread" class="rerr-badge mono">{{ center.unreadCount }}</span>
    </button>
    <transition name="rerr-pop">
      <div v-if="open" class="rerr-panel" @click.stop>
        <div class="rerr-head">
          <span>{{ t('Refresh failures') }}</span>
          <button type="button" class="rerr-clear" @click="center.clearRefreshHistory()">
            {{ t('Clear') }}
          </button>
        </div>
        <ErrorRecordCard
          v-for="rec in center.refreshHistory"
          :key="rec.id"
          :record="rec"
          :expanded="expanded === rec.id"
          @toggle="expanded = expanded === rec.id ? null : rec.id"
        />
      </div>
    </transition>
  </div>
</template>

<style scoped>
.rerr {
  position: relative;
  display: inline-flex;
}
.rerr-btn {
  cursor: pointer;
  position: relative;
}
/* Red only while unread. The mark stays after the list is read — a permanent
   red one would keep claiming attention it no longer needs. */
.rerr-btn :deep(svg) {
  color: var(--sw-fg-2);
}
.rerr-btn.unread :deep(svg) {
  color: var(--sw-danger, #e5534b);
}
.rerr-badge {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 12px;
  height: 12px;
  padding: 0 2px;
  border-radius: 6px;
  background: var(--sw-danger, #e5534b);
  color: #fff;
  font-size: 8.5px;
  line-height: 12px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.rerr-panel {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  width: 320px;
  max-height: 60vh;
  overflow: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  /* Above the connectivity banner (z-index 50), which the panel opens over.
     At 20 the banner painted THROUGH it — its red strip and text showing
     across the failure cards, which reads as a rendering fault rather than as
     two things that happen to overlap. */
  z-index: 60;
}
.rerr-head {
  display: flex;
  align-items: center;
  font-size: 10.5px;
  color: var(--sw-fg-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.rerr-clear {
  margin-left: auto;
  background: none;
  border: none;
  padding: 0;
  color: var(--sw-accent-2, var(--sw-accent));
  font: inherit;
  text-transform: none;
  letter-spacing: 0;
  cursor: pointer;
}
.rerr-pop-enter-from,
.rerr-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.rerr-pop-enter-active,
.rerr-pop-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
</style>
