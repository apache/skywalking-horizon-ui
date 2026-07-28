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
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import Icon from '@/components/icons/Icon.vue';
import ChatTranscript from './ChatTranscript.vue';
import ChatComposer from './ChatComposer.vue';
import ChatScopeBar from './ChatScopeBar.vue';
import { useAuthStore } from '@/state/auth';
import { useAiChat } from './useAiChat';
import { useAiConversations, type ConversationStatus } from './useAiConversations';
import { useChatScroll } from './useChatScroll';
import type { Conversation } from './types';

const { t } = useI18n({ useScope: 'global' });
const router = useRouter();
const auth = useAuthStore();
const chat = useAiChat();
const conv = useAiConversations();
// This route is fullscreen (outside AppShell, so the launcher — which owns the
// config probe + hydrate — isn't mounted). Load config + this user's history
// here on mount AND whenever auth settles, so a reload before the session has
// bootstrapped still hydrates history once the user is known.
function loadHistory(): void {
  void chat
    .ensureConfig()
    .then(() => conv.hydrate())
    .then(() => {
      savingHistory.value = conv.historyEnabled();
      refreshUsage();
    });
}
onMounted(loadHistory);
watch(() => auth.isAuthenticated, loadHistory);

const ordered = computed<Conversation[]>(() => [...conv.conversations.value].sort((a, b) => b.updatedAt - a.updatedAt));

// A row the store has no entry for was loaded from an earlier session and never
// touched here, so it is at rest — same as `saved`, never `active`.
const rows = computed<{ c: Conversation; status: ConversationStatus }[]>(() =>
  ordered.value.map((c) => ({ c, status: conv.status.value[c.id] ?? 'saved' })),
);
function statusLabel(s: ConversationStatus): string {
  return s === 'conflicted' ? t('Not saved') : t('In progress');
}
function statusHint(s: ConversationStatus): string {
  return s === 'conflicted'
    ? t('Also continued in another tab, so this version was not saved. Open it to pick the version to keep.')
    : t('A turn is still in flight — the newest state is not saved yet.');
}

const savingHistory = ref(conv.historyEnabled());
const confirmingClear = ref(false);
const usedBytes = ref(0);
const maxBytes = computed(() => chat.history.value?.clientMaxBytes ?? 0);
const showUnencryptedWarning = computed(() => savingHistory.value && chat.history.value?.mode === 'client');

function refreshUsage(): void {
  void conv.usageBytes().then((b) => (usedBytes.value = b));
}
function toggleSaving(): void {
  savingHistory.value = !savingHistory.value;
  void conv.setHistoryEnabled(savingHistory.value).then(refreshUsage);
}
function clickClear(): void {
  if (!confirmingClear.value) {
    confirmingClear.value = true;
    return;
  }
  confirmingClear.value = false;
  void conv.clearAll().then(refreshUsage);
}
// Adaptive unit: real usage is KB-scale against a huge (500 MB) cap, so a
// fixed "MB, 1 decimal" reads 0.0 forever. Show B / KB / MB so small usage — and
// its growth — is actually visible.
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
// Refresh usage when a turn finishes — covers growth WITHIN a conversation, not
// just a change in conversation count.
watch(
  () => conv.streaming.value,
  (v) => {
    if (!v) refreshUsage();
  },
);
const messages = computed(() => conv.current.value?.messages ?? []);
const body = ref<HTMLElement | null>(null);
// Pin the message you just sent to the top of the scroll area; the answer
// streams in below it. Switching conversations lands on the latest turn.
useChatScroll({
  container: body,
  messages,
  conversationId: computed<string | null>(() => conv.currentId.value ?? null),
});

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
        <template v-if="chat.ready.value">
          <ChatScopeBar />
          <button type="button" class="aifp__btn" @click="conv.newChat()"><Icon name="plus" :size="13" />{{ t('New chat') }}</button>
        </template>
        <button type="button" class="aifp__btn" @click="dockToSide"><Icon name="expand" :size="13" />{{ t('Dock to side') }}</button>
      </div>
    </header>

    <!-- Read-only setup state: the assistant is reachable by everyone, but can
         only chat once an admin has configured a model provider. -->
    <div v-if="!chat.ready.value" class="aifp__setup">
      <span class="aifp__setup-mark" aria-hidden="true"><Icon name="ai" :size="34" /></span>
      <h2 class="aifp__setup-title">{{ t('The AI Assistant is not set up yet') }}</h2>
      <p class="aifp__setup-text">
        {{ t('It answers questions about your services, metrics, traces and logs from live data — but a model provider must be configured first.') }}
      </p>
      <p class="aifp__setup-tip">
        {{ t('Ask your administrator to enable it and configure a model provider and API key.') }}
      </p>
    </div>

    <div v-else class="aifp__main">
      <aside class="aifp__hist">
        <div class="aifp__hist-head">{{ t('History') }}</div>
        <div class="aifp__hist-list">
          <div v-if="ordered.length === 0" class="aifp__hist-empty">{{ t('No conversations yet.') }}</div>
          <button
            v-for="{ c, status } in rows"
            :key="c.id"
            type="button"
            class="aifp__hist-row"
            :class="{ active: c.id === conv.currentId.value }"
            @click="conv.select(c.id)"
          >
            <span class="aifp__hist-title">{{ c.title || t('New chat') }}</span>
            <span class="aifp__hist-meta">
              <span class="aifp__hist-time">{{ when(c.updatedAt) }}</span>
              <!-- `saved` is the resting state of every row, so it carries no tag —
                   only the two states that mean "not written yet" are marked, and the
                   conflicted one also gets an icon so it doesn't read by colour alone. -->
              <span v-if="status !== 'saved'" class="aifp__hist-tag" :class="status" :title="statusHint(status)">
                <Icon v-if="status === 'conflicted'" name="alert" :size="10" />{{ statusLabel(status) }}
              </span>
            </span>
            <span class="aifp__hist-del" :title="t('Delete')" @click.stop="conv.remove(c.id)"><Icon name="trash" :size="12" /></span>
          </button>
        </div>

        <div class="aifp__hist-foot">
          <label class="aifp__save">
            <input type="checkbox" :checked="savingHistory" @change="toggleSaving" />
            <span>{{ t('Save history') }}</span>
          </label>
          <p v-if="showUnencryptedWarning" class="aifp__warn">
            {{ t('History is stored unencrypted in this browser.') }}
          </p>
          <div v-if="savingHistory && maxBytes > 0" class="aifp__usage">
            <div class="aifp__usage-bar">
              <div class="aifp__usage-fill" :style="{ width: Math.min(100, (usedBytes / maxBytes) * 100) + '%' }" />
            </div>
            <span class="aifp__usage-txt">{{ fmtSize(usedBytes) }} / {{ fmtSize(maxBytes) }}</span>
          </div>
          <div v-if="ordered.length > 0" class="aifp__clear">
            <button v-if="!confirmingClear" type="button" class="aifp__clear-btn" @click="clickClear">{{ t('Clear all') }}</button>
            <template v-else>
              <button type="button" class="aifp__clear-btn danger" @click="clickClear">{{ t('Confirm clear all') }}</button>
              <button type="button" class="aifp__clear-btn" @click="confirmingClear = false">{{ t('Cancel') }}</button>
            </template>
          </div>
        </div>
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
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 8px;
}
.aifp__hist-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.aifp__hist-head {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  padding: 8px 8px 6px;
}
.aifp__hist-foot {
  flex: 0 0 auto;
  border-top: 1px solid var(--sw-line);
  margin-top: 8px;
  padding: 10px 8px 4px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.aifp__save {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
  cursor: pointer;
}
.aifp__save input {
  accent-color: var(--sw-accent);
  cursor: pointer;
}
.aifp__warn {
  margin: 0;
  font-size: var(--sw-fs-xs);
  line-height: var(--sw-lh-normal);
  color: var(--sw-warn);
}
.aifp__usage {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.aifp__usage-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--sw-bg-3);
  overflow: hidden;
}
.aifp__usage-fill {
  height: 100%;
  background: var(--sw-accent);
}
.aifp__usage-txt {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
  font-variant-numeric: tabular-nums;
}
.aifp__clear {
  display: flex;
  gap: 6px;
}
.aifp__clear-btn {
  height: 26px;
  padding: 0 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: var(--sw-fs-sm);
  cursor: pointer;
}
.aifp__clear-btn:hover {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
}
.aifp__clear-btn.danger {
  border-color: var(--sw-err);
  color: var(--sw-err);
}
.aifp__clear-btn.danger:hover {
  background: var(--sw-err-soft);
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
.aifp__hist-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
}
.aifp__hist-time {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}
.aifp__hist-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 14px;
  padding: 0 5px;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  line-height: 1;
  white-space: nowrap;
  color: var(--sw-fg-3);
}
.aifp__hist-tag.conflicted {
  border-color: var(--sw-warn);
  background: var(--sw-warn-soft);
  color: var(--sw-warn);
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
  /* Don't let the browser follow streamed content growth — the pin-to-top
     scroll owns the position (see useChatScroll). */
  overflow-anchor: none;
  /* The full-page conversation sits over --sw-bg-0 (not the drawer's bg-1);
     tell the sticky question header to match. */
  --tx-sticky-bg: var(--sw-bg-0);
  /* Top padding lives on .tx (it scrolls) so the sticky question header can
     stick flush to the top with no gap above it. */
  padding: 0 20px 24px;
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

.aifp__setup {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 14px;
  padding: 40px;
}
.aifp__setup-mark {
  width: 60px;
  height: 60px;
  display: grid;
  place-items: center;
  border-radius: 16px;
  background: linear-gradient(135deg, var(--sw-accent) 0%, var(--sw-purple) 115%);
  color: #fff;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06) inset;
}
.aifp__setup-title {
  margin: 0;
  font-size: var(--sw-fs-xl);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
}
.aifp__setup-text {
  margin: 0;
  max-width: 52ch;
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-2);
  line-height: var(--sw-lh-normal);
}
.aifp__setup-tip {
  margin: 6px 0 0;
  max-width: 52ch;
  font-size: var(--sw-fs-base);
  font-weight: var(--sw-fw-medium);
  color: var(--sw-fg-1);
  padding: 12px 16px;
  border: 1px solid var(--sw-line-2);
  border-radius: 10px;
  background: var(--sw-bg-1);
}
</style>
