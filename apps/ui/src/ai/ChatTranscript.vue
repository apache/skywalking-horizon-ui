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
<!-- Renders a conversation as an ordered narrative: user bubbles, assistant prose
     interleaved with numbered figure blocks + tool chips. Pure display. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import ChatFigureBlock from './ChatFigureBlock.vue';
import ChatSubPageBlock from './ChatSubPageBlock.vue';
import ChatProposalBlock from './ChatProposalBlock.vue';
import ChatPodLogsBlock from './ChatPodLogsBlock.vue';
import ChatHierarchyBlock from './ChatHierarchyBlock.vue';
import ChatTopologyBlock from './ChatTopologyBlock.vue';
import ChatDeploymentBlock from './ChatDeploymentBlock.vue';
import ChatInstanceTopologyBlock from './ChatInstanceTopologyBlock.vue';
import ChatEndpointDependencyBlock from './ChatEndpointDependencyBlock.vue';
import ChatTracesBlock from './ChatTracesBlock.vue';
import ChatZipkinTracesBlock from './ChatZipkinTracesBlock.vue';
import ChatLogsBlock from './ChatLogsBlock.vue';
import ChatBrowserErrorsBlock from './ChatBrowserErrorsBlock.vue';
import ChatStarters from './ChatStarters.vue';
import { renderMarkdown } from './markdown';
import type { ChatMessage } from './types';

const props = withDefaults(defineProps<{ messages: ChatMessage[]; starters?: string[] }>(), {
  starters: () => [],
});
const emit = defineEmits<{ (e: 'ask', text: string): void }>();
const { t } = useI18n({ useScope: 'global' });

// The most recent question stays stuck to the top of the scroll area while its
// answer streams / is scrolled through (see .tx__msg--sticky).
const latestUserId = computed<string | null>(() => {
  const ms = props.messages;
  for (let i = ms.length - 1; i >= 0; i--) {
    if (ms[i]!.role === 'user') return ms[i]!.id;
  }
  return null;
});

function textOf(m: ChatMessage): string {
  return m.blocks
    .filter((b): b is Extract<typeof b, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('');
}

function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div class="tx">
    <div v-if="messages.length === 0" class="tx__empty">
      <p class="tx__empty-lead">{{ t('Ask a question to get started.') }}</p>
      <p class="tx__empty-hint">
        {{ t('Answers stream back as an ordered narrative with inline charts, tables and lists — powered by the same widgets you see across the dashboards.') }}
      </p>
      <ChatStarters v-if="starters.length" :starters="starters" @ask="(text) => emit('ask', text)" />
    </div>

    <div
      v-for="m in messages"
      :key="m.id"
      class="tx__msg"
      :class="[m.role, { 'tx__msg--sticky': m.role === 'user' && m.id === latestUserId }]"
    >
      <!-- user turn -->
      <div v-if="m.role === 'user'" class="tx__ubox">
        <div class="tx__bubble">{{ textOf(m) }}</div>
        <time v-if="m.at" class="tx__time">{{ fmtTime(m.at) }}</time>
      </div>

      <!-- assistant turn: ordered blocks -->
      <div v-else class="tx__answer">
        <template v-for="(b, i) in m.blocks" :key="i">
          <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapes HTML before formatting (see markdown.ts), so LLM output cannot inject -->
          <div v-if="b.kind === 'text'" class="tx__prose" v-html="renderMarkdown(b.text)"></div>
          <ChatFigureBlock v-else-if="b.kind === 'figure'" :block="b" />
          <ChatSubPageBlock v-else-if="b.kind === 'subpage'" :n="b.n" :spec="b.spec" />
          <ChatProposalBlock v-else-if="b.kind === 'proposal'" :block="b" />
          <ChatPodLogsBlock v-else-if="b.kind === 'podlogs'" :n="b.n" :spec="b.spec" />
          <ChatHierarchyBlock v-else-if="b.kind === 'hierarchy'" :n="b.n" :spec="b.spec" />
          <ChatTopologyBlock v-else-if="b.kind === 'topology'" :n="b.n" :spec="b.spec" />
          <ChatDeploymentBlock v-else-if="b.kind === 'deployment'" :n="b.n" :spec="b.spec" />
          <ChatInstanceTopologyBlock v-else-if="b.kind === 'instance-topology'" :n="b.n" :spec="b.spec" />
          <ChatEndpointDependencyBlock v-else-if="b.kind === 'endpoint-dependency'" :n="b.n" :spec="b.spec" />
          <ChatTracesBlock v-else-if="b.kind === 'traces'" :n="b.n" :spec="b.spec" />
          <ChatZipkinTracesBlock v-else-if="b.kind === 'zipkin-traces'" :n="b.n" :spec="b.spec" />
          <ChatLogsBlock v-else-if="b.kind === 'logs'" :n="b.n" :spec="b.spec" />
          <ChatBrowserErrorsBlock v-else-if="b.kind === 'browser-errors'" :n="b.n" :spec="b.spec" />
          <span v-else class="tx__tool" :class="b.status">
            <span class="tx__tool-dot" />{{ b.name }}
          </span>
        </template>
        <span v-if="m.streaming" class="tx__caret" aria-hidden="true" />
        <span v-if="m.interrupted" class="tx__interrupted">{{ t('Interrupted') }}</span>
        <time v-if="m.at && !m.streaming" class="tx__time tx__time--reply">{{ fmtTime(m.at) }}</time>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tx {
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* Resting top breathing room; scrolls away so the sticky question header
     (its container's top padding is 0) sticks flush to the top. */
  padding-top: 12px;
}
.tx__empty {
  margin-top: 6px;
  padding: 18px;
  border: 1px dashed var(--sw-line-2);
  border-radius: 10px;
  background: var(--sw-bg-0);
}
.tx__empty-lead {
  margin: 0 0 6px;
  font-size: var(--sw-fs-md);
  color: var(--sw-fg-0);
}
.tx__empty-hint {
  margin: 0 0 12px;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-2);
  line-height: var(--sw-lh-normal);
}
.tx__msg.user {
  display: flex;
  justify-content: flex-end;
}
/* The latest question sticks to the top of the scroll area so it stays visible
   while its answer streams / is scrolled through. The opaque background (matched
   to the container via --tx-sticky-bg) hides the answer as it scrolls under it;
   the soft shadow separates the two. Only the latest user turn gets this — older
   questions scroll normally. */
.tx__msg--sticky {
  position: sticky;
  top: 0;
  z-index: 4;
  background: var(--tx-sticky-bg, var(--sw-bg-1));
  padding-block: 8px;
  box-shadow: 0 8px 10px -8px rgba(0, 0, 0, 0.55);
}
/* User turn: bubble + its sent-time, stacked and right-aligned. */
.tx__ubox {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  max-width: 82%;
}
.tx__bubble {
  max-width: 100%;
  background: var(--sw-accent-soft);
  border: 1px solid var(--sw-accent-line);
  color: var(--sw-fg-0);
  border-radius: 10px 10px 2px 10px;
  padding: 8px 11px;
  font-size: var(--sw-fs-base);
  line-height: var(--sw-lh-normal);
}
/* Sent-time (user) / reply-time (assistant), muted + monospaced digits. */
.tx__time {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
  font-variant-numeric: tabular-nums;
}
.tx__time--reply {
  display: block;
  margin-top: 6px;
}
.tx__answer {
  min-width: 0;
}
.tx__prose {
  margin: 0 0 8px;
  font-size: var(--sw-fs-base);
  line-height: var(--sw-lh-relaxed);
  color: var(--sw-fg-1);
}
/* Rendered-markdown elements (renderMarkdown → v-html). Dense, chat-scale
   headings; the design token vocabulary for code / links / lists. */
.tx__prose :deep(p) {
  margin: 0 0 8px;
}
.tx__prose :deep(p:last-child) {
  margin-bottom: 0;
}
.tx__prose :deep(h4),
.tx__prose :deep(h5),
.tx__prose :deep(h6) {
  margin: 12px 0 6px;
  color: var(--sw-fg-0);
  font-weight: var(--sw-fw-semibold);
  line-height: var(--sw-lh-tight);
}
.tx__prose :deep(h4) {
  font-size: var(--sw-fs-md);
}
.tx__prose :deep(h5),
.tx__prose :deep(h6) {
  font-size: var(--sw-fs-base);
}
.tx__prose :deep(ul),
.tx__prose :deep(ol) {
  margin: 4px 0 8px;
  padding-left: 20px;
}
.tx__prose :deep(li) {
  margin: 2px 0;
}
.tx__prose :deep(strong) {
  color: var(--sw-fg-0);
  font-weight: var(--sw-fw-semibold);
}
.tx__prose :deep(a) {
  color: var(--sw-accent-2);
  text-decoration: underline;
}
.tx__prose :deep(code) {
  font-family: var(--sw-mono);
  font-size: 0.92em;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  padding: 1px 4px;
}
.tx__prose :deep(pre) {
  margin: 6px 0 8px;
  padding: 8px 10px;
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  overflow-x: auto;
}
.tx__prose :deep(pre code) {
  background: none;
  border: 0;
  padding: 0;
}
.tx__tool {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 20px;
  padding: 0 8px;
  margin: 0 6px 8px 0;
  border-radius: 5px;
  font-size: var(--sw-fs-xs);
  font-family: var(--sw-mono);
  background: var(--sw-bg-3);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
}
.tx__tool-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--sw-fg-3);
}
.tx__tool.running .tx__tool-dot {
  background: var(--sw-accent);
  animation: tx-blink 1s steps(2, start) infinite;
}
.tx__tool.done .tx__tool-dot {
  background: var(--sw-ok);
}
.tx__tool.denied .tx__tool-dot {
  background: var(--sw-err);
}
@keyframes tx-blink {
  50% {
    opacity: 0.3;
  }
}
.tx__caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  vertical-align: -2px;
  background: var(--sw-accent);
  border-radius: 1px;
  animation: tx-blink 1s steps(2, start) infinite;
}
/* Shown when the user stopped the answer mid-stream (ESC / Stop). */
.tx__interrupted {
  display: inline-block;
  margin-top: 6px;
  padding: 1px 7px;
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  font-size: var(--sw-fs-xs);
  font-family: var(--sw-mono);
  color: var(--sw-fg-3);
}
</style>
