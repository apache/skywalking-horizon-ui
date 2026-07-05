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
<!-- Full-page /ai: a fullscreen route outside AppShell — history sidebar + wide
     conversation column. Same conversation + history as the docked drawer. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import Icon from '@/components/icons/Icon.vue';
import ChatTranscript from './ChatTranscript.vue';
import ChatComposer from './ChatComposer.vue';
import ChatScopeBar from './ChatScopeBar.vue';
import { useAiChat } from './useAiChat';
import { useAiConversations } from './useAiConversations';
import type { Conversation } from './types';

const { t } = useI18n({ useScope: 'global' });
const router = useRouter();
const chat = useAiChat();
// This route is fullscreen (outside AppShell, so the launcher isn't mounted) —
// load the AI config here too so starters render on a direct /ai landing.
onMounted(() => void chat.ensureConfig());
const conv = useAiConversations();

const ordered = computed<Conversation[]>(() => [...conv.conversations.value].sort((a, b) => b.updatedAt - a.updatedAt));
const messages = computed(() => conv.current.value?.messages ?? []);
const body = ref<HTMLElement | null>(null);

function scrollToBottom(): void {
  if (body.value) body.value.scrollTop = body.value.scrollHeight;
}
const scrollSignal = computed<string>(() => {
  const ms = messages.value;
  const last = ms[ms.length - 1];
  const lb = last?.blocks[last.blocks.length - 1];
  const tlen = lb && lb.kind === 'text' ? lb.text.length : 0;
  return `${conv.currentId.value ?? ''}:${ms.length}:${last?.blocks.length ?? 0}:${tlen}`;
});
watch(scrollSignal, () => void nextTick(scrollToBottom));

function onSend(text: string): void {
  void conv.send(text);
}
function dockToSide(): void {
  void router.push('/').then(() => chat.openPanel());
}
function when(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div class="aifp">
    <header class="aifp__top">
      <span class="aifp__mark" aria-hidden="true"><Icon name="ai" :size="16" /></span>
      <strong class="aifp__brand">{{ t('AI Assistant') }}</strong>
      <div class="aifp__top-acts">
        <ChatScopeBar />
        <button type="button" class="aifp__btn" @click="conv.newChat()"><Icon name="plus" :size="13" />{{ t('New chat') }}</button>
        <button type="button" class="aifp__btn" @click="dockToSide"><Icon name="expand" :size="13" />{{ t('Dock to side') }}</button>
      </div>
    </header>

    <div class="aifp__main">
      <aside class="aifp__hist">
        <div class="aifp__hist-head">{{ t('History') }}</div>
        <div v-if="ordered.length === 0" class="aifp__hist-empty">{{ t('No conversations yet.') }}</div>
        <button
          v-for="c in ordered"
          :key="c.id"
          type="button"
          class="aifp__hist-row"
          :class="{ active: c.id === conv.currentId.value }"
          @click="conv.select(c.id)"
        >
          <span class="aifp__hist-title">{{ c.title || t('New chat') }}</span>
          <span class="aifp__hist-time">{{ when(c.updatedAt) }}</span>
          <span class="aifp__hist-del" :title="t('Delete')" @click.stop="conv.remove(c.id)"><Icon name="trash" :size="12" /></span>
        </button>
      </aside>

      <section class="aifp__conv">
        <div ref="body" class="aifp__scroll">
          <div class="aifp__col">
            <ChatTranscript :messages="messages" :starters="chat.starters.value" @ask="onSend" />
          </div>
        </div>
        <footer class="aifp__composer">
          <div class="aifp__col">
            <ChatComposer :streaming="conv.streaming.value" @send="onSend" @stop="conv.stop()" />
          </div>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.aifp {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(1200px 600px at 20% -10%, rgba(249, 115, 22, 0.05), transparent 60%),
    radial-gradient(900px 500px at 100% 0%, rgba(168, 85, 247, 0.05), transparent 60%),
    var(--sw-bg-0);
  color: var(--sw-fg-0);
  font-family: var(--sw-sans);
}

.aifp__top {
  flex: 0 0 auto;
  height: 48px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
}
.aifp__mark {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  background: linear-gradient(135deg, var(--sw-accent) 0%, var(--sw-purple) 115%);
  color: #fff;
}
.aifp__brand {
  font-size: var(--sw-fs-lg);
  font-weight: var(--sw-fw-semibold);
}
.aifp__top-acts {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.aifp__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 7px;
  color: var(--sw-fg-1);
  font: inherit;
  font-size: var(--sw-fs-sm);
  cursor: pointer;
}
.aifp__btn:hover {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
}

.aifp__main {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: 260px 1fr;
  /* Bound the single row to the container height (not content), so the
     conversation column scrolls INSIDE .aifp__scroll instead of growing past
     the fixed viewport and pushing the composer footer off-screen. */
  grid-template-rows: minmax(0, 1fr);
}

.aifp__hist {
  border-right: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  overflow-y: auto;
  padding: 8px;
}
.aifp__hist-head {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  padding: 8px 8px 6px;
}
.aifp__hist-empty {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
  padding: 8px;
}
.aifp__hist-row {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 7px;
  padding: 7px 9px;
  color: var(--sw-fg-1);
  font: inherit;
  cursor: pointer;
}
.aifp__hist-row:hover {
  background: var(--sw-bg-2);
}
.aifp__hist-row.active {
  background: var(--sw-bg-3);
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.aifp__hist-title {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.aifp__hist-time {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}
.aifp__hist-del {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 18px;
  height: 18px;
  display: none;
  place-items: center;
  border-radius: 4px;
  color: var(--sw-fg-3);
  font-size: 14px;
}
.aifp__hist-row:hover .aifp__hist-del {
  display: grid;
}
.aifp__hist-del:hover {
  background: var(--sw-err-soft);
  color: var(--sw-err);
}

.aifp__conv {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.aifp__scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 20px;
}
.aifp__composer {
  flex: 0 0 auto;
  border-top: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  padding: 12px 20px;
}
/* Center + cap the conversation width so long figures/prose stay readable on wide screens. */
.aifp__col {
  max-width: 900px;
  margin: 0 auto;
}
</style>
