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
<!-- Docked slide-over drawer (non-blocking). Expand ⤢ → full-page /ai; ↗ → a new browser
     tab (hydrates from shared localStorage history). Mounted once in AppShell. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import Icon from '@/components/icons/Icon.vue';
import ChatTranscript from './ChatTranscript.vue';
import ChatComposer from './ChatComposer.vue';
import ChatScopeBar from './ChatScopeBar.vue';
import { useAiChat } from './useAiChat';
import { useAiConversations } from './useAiConversations';

const { t } = useI18n({ useScope: 'global' });
const router = useRouter();
const chat = useAiChat();
const conv = useAiConversations();

const messages = computed(() => conv.current.value?.messages ?? []);
const body = ref<HTMLElement | null>(null);

function scrollToBottom(): void {
  if (body.value) body.value.scrollTop = body.value.scrollHeight;
}
// React to new messages, new blocks, and streamed-token growth.
const scrollSignal = computed<string>(() => {
  const ms = messages.value;
  const last = ms[ms.length - 1];
  const lb = last?.blocks[last.blocks.length - 1];
  const tlen = lb && lb.kind === 'text' ? lb.text.length : 0;
  return `${ms.length}:${last?.blocks.length ?? 0}:${tlen}`;
});
watch(scrollSignal, () => void nextTick(scrollToBottom));

function onSend(text: string): void {
  void conv.send(text);
}
function expand(): void {
  // Keep the stream running — the full-page view continues the same conversation.
  chat.closePanel();
  void router.push({ name: 'ai' });
}
function openNewTab(): void {
  const href = router.resolve({ name: 'ai' }).href;
  window.open(href, '_blank', 'noopener');
}
// Closing the drawer (× or Esc) aborts the in-flight answer so a dismissed panel
// stops consuming the model instead of streaming to nowhere.
function closeDrawer(): void {
  conv.stop();
  chat.closePanel();
}

// Resizable width — drag the left edge to widen/narrow; clamped and remembered.
// Width is a fraction of the viewport: 30%–60%, default 40%, with a fixed pixel
// floor (MINI_W) so it never collapses to unusable on a small screen.
const DRAWER_W_KEY = 'sw.ai.drawerWidth';
const MINI_W = 380;
const minW = (): number => Math.max(MINI_W, Math.round(window.innerWidth * 0.3));
const maxW = (): number => Math.max(MINI_W, Math.round(window.innerWidth * 0.6));
const clampW = (v: number): number => Math.max(minW(), Math.min(maxW(), v));
const defaultW = (): number => clampW(Math.round(window.innerWidth * 0.4));
function loadW(): number {
  try {
    const v = Number(localStorage.getItem(DRAWER_W_KEY));
    return Number.isFinite(v) && v > 0 ? clampW(v) : defaultW();
  } catch {
    return defaultW();
  }
}
const drawerWidth = ref<number>(loadW());
const resizing = ref(false);
function startResize(e: MouseEvent): void {
  e.preventDefault();
  resizing.value = true;
  const startX = e.clientX;
  const startW = drawerWidth.value;
  const onMove = (ev: MouseEvent): void => {
    // The drawer hugs the right edge, so dragging its left handle leftward widens it.
    drawerWidth.value = clampW(startW + (startX - ev.clientX));
  };
  const onUp = (): void => {
    resizing.value = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    try {
      localStorage.setItem(DRAWER_W_KEY, String(drawerWidth.value));
    } catch {
      /* storage disabled — the width just won't persist */
    }
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}
function onWindowResize(): void {
  drawerWidth.value = clampW(drawerWidth.value);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !chat.open.value) return;
  // ESC interrupts an in-flight answer — it does NOT close the dock (that's the
  // × button). Only acts while streaming; otherwise ESC is a no-op here.
  if (conv.streaming.value) {
    e.preventDefault();
    conv.stop();
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onWindowResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onWindowResize);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="ai-drawer">
      <aside
        v-if="chat.open.value"
        class="ai-drawer"
        :class="{ 'ai-drawer--resizing': resizing }"
        :style="{ width: drawerWidth + 'px' }"
        role="dialog"
        aria-modal="false"
        :aria-label="t('AI Assistant')"
      >
        <div
          class="ai-drawer__resize"
          role="separator"
          aria-orientation="vertical"
          :aria-label="t('Resize panel')"
          @mousedown="startResize"
        ></div>
        <header class="ai-drawer__head">
          <span class="ai-drawer__mark" aria-hidden="true"><Icon name="ai" :size="16" /></span>
          <div class="ai-drawer__title">
            <strong>{{ t('AI Assistant') }}</strong>
            <span class="ai-drawer__sub">{{ t('Ask about your services, metrics, traces and logs') }}</span>
          </div>
          <div class="ai-drawer__acts">
            <button type="button" class="ai-drawer__act" :aria-label="t('New chat')" :title="t('New chat')" @click="conv.newChat()"><Icon name="plus" :size="14" /></button>
            <button type="button" class="ai-drawer__act" :aria-label="t('Expand to full page')" :title="t('Expand to full page')" @click="expand"><Icon name="expand" :size="14" /></button>
            <button type="button" class="ai-drawer__act" :aria-label="t('Open in a new tab')" :title="t('Open in a new tab')" @click="openNewTab"><Icon name="external" :size="14" /></button>
            <button type="button" class="ai-drawer__act" :aria-label="t('Close')" :title="t('Close')" @click="closeDrawer()"><Icon name="close" :size="14" /></button>
          </div>
        </header>

        <div class="ai-drawer__scopebar"><ChatScopeBar /></div>

        <div ref="body" class="ai-drawer__body">
          <ChatTranscript :messages="messages" :starters="chat.starters.value" @ask="onSend" />
        </div>

        <footer class="ai-drawer__composer">
          <ChatComposer :streaming="conv.streaming.value" @send="onSend" @stop="conv.stop()" />
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ai-drawer {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 420;
  height: 100vh;
  /* width is bound inline (resizable + persisted, 30–60vw); cap as a backstop. */
  max-width: 80vw;
  display: flex;
  flex-direction: column;
  background: var(--sw-bg-1);
  /* A clear boundary against the page it docks over: a defined edge + a deep
     shadow so the drawer reads as a distinct surface, not a merged panel. */
  border-left: 1px solid var(--sw-line);
  box-shadow: -30px 0 80px -18px rgba(0, 0, 0, 0.85);
}
.ai-drawer--resizing {
  user-select: none;
}
/* Drag handle on the left edge to resize the drawer. */
.ai-drawer__resize {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 3;
}
.ai-drawer__resize::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  /* Always faintly visible so the boundary + drag affordance read at rest;
     brightens to the accent on hover / while dragging. */
  background: var(--sw-line-2);
  transition: background 120ms ease;
}
.ai-drawer__resize:hover::after,
.ai-drawer--resizing .ai-drawer__resize::after {
  background: var(--sw-accent);
}

.ai-drawer__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
}
.ai-drawer__mark {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  background: linear-gradient(135deg, var(--sw-accent) 0%, var(--sw-purple) 115%);
  color: #fff;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06) inset;
}
.ai-drawer__title {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.ai-drawer__title strong {
  font-size: var(--sw-fs-md);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
}
.ai-drawer__sub {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-drawer__acts {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.ai-drawer__act {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  color: var(--sw-fg-2);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.ai-drawer__act:hover {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
}

.ai-drawer__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 14px;
}
.ai-drawer__composer {
  flex: 0 0 auto;
  padding: 10px 12px;
  border-top: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
}
.ai-drawer__scopebar {
  flex: 0 0 auto;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
}

.ai-drawer-enter-active,
.ai-drawer-leave-active {
  transition: transform 200ms ease;
}
.ai-drawer-enter-from,
.ai-drawer-leave-to {
  transform: translateX(100%);
}
@media (prefers-reduced-motion: reduce) {
  .ai-drawer-enter-active,
  .ai-drawer-leave-active {
    transition: none;
  }
}
</style>
