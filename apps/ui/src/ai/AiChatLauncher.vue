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
<!-- Floating edge launcher: fixed, collapsed to a sparkle badge, expands on hover.
     Teleported to <body>. One-shot first-run nudge (reduced-motion aware). -->
<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import { useAuthStore } from '@/state/auth';
import { useAiChat } from './useAiChat';

const { t } = useI18n({ useScope: 'global' });
const chat = useAiChat();
const auth = useAuthStore();

// Probe the server AI config once authenticated (and re-probe after login) so
// the launcher gates on `ready` + seeds the starters. The component is always
// mounted in AppShell, so this fires regardless of `available`.
onMounted(() => {
  if (auth.isAuthenticated) void chat.ensureConfig();
});
watch(
  () => auth.isAuthenticated,
  (yes) => {
    if (yes) void chat.ensureConfig();
  },
);
</script>

<template>
  <Teleport to="body">
    <button
      v-if="chat.available.value && !chat.open.value"
      type="button"
      class="ai-fab"
      :class="{ 'is-hint': chat.showHint.value }"
      :aria-label="t('Open AI assistant')"
      :title="t('Open AI assistant')"
      @click="chat.openPanel()"
    >
      <Icon class="ai-fab__mark" name="ai" :size="18" />
      <span class="ai-fab__label">{{ t('AI Assistant') }}</span>
    </button>
  </Teleport>
</template>

<style scoped>
.ai-fab {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 400;

  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 12px 0 10px;
  max-width: 40px; /* collapsed: shows just the mark */

  background: linear-gradient(135deg, var(--sw-accent) 0%, var(--sw-purple) 115%);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-right: 0;
  border-radius: 10px 0 0 10px;
  box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05) inset;

  cursor: pointer;
  overflow: hidden;
  transition: max-width 180ms ease, box-shadow 180ms ease, transform 180ms ease;
}
.ai-fab:hover,
.ai-fab:focus-visible {
  max-width: 160px;
  box-shadow: 0 14px 34px -10px rgba(0, 0, 0, 0.7), 0 0 22px -6px var(--sw-accent);
  outline: none;
}

.ai-fab__mark {
  flex: 0 0 auto;
  display: block;
}
.ai-fab__label {
  white-space: nowrap;
  font-size: var(--sw-fs-sm);
  font-weight: var(--sw-fw-semibold);
  opacity: 0;
  transition: opacity 140ms ease;
}
.ai-fab:hover .ai-fab__label,
.ai-fab:focus-visible .ai-fab__label {
  opacity: 1;
}

/* First-run nudge: a small horizontal "bob" toward the page a few times, plus a
   soft glow, so the operator notices the new surface without being nagged. */
.ai-fab.is-hint {
  animation: ai-fab-bob 0.62s ease-in-out 3 120ms;
  box-shadow: 0 14px 34px -10px rgba(0, 0, 0, 0.7), 0 0 24px -4px var(--sw-accent);
}
@keyframes ai-fab-bob {
  0%,
  100% {
    transform: translateY(-50%) translateX(0);
  }
  50% {
    transform: translateY(-50%) translateX(-7px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-fab {
    transition: box-shadow 180ms ease;
  }
  .ai-fab.is-hint {
    animation: none;
  }
}
</style>
