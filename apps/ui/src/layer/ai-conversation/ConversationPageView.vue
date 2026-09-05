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
  One AI agent conversation, full page, outside the AppShell. The document is
  tens of megabytes and a reader keeps it open beside the list, so the list
  opens it in its own tab; the URL carries the conversation, its service and
  sender, and the reader's position (talk / step / stream), so it can be
  shared and lands on the same step. The page reads the document through the
  BFF, showing the bytes as they arrive — OAP folds the whole chain before the
  first byte, so a large conversation is quiet for a while first — and hands
  it to the shared renderer.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { isSupportedDocument, type AszViewDocument, type PublicState } from '@skywalking-horizon-ui/conversation-view';
import logoSw from '@/assets/icons/logo-sw.svg?raw';
import { bff } from '@/api/client';
import { AiConversationViewError } from '@/api/scopes/ai-conversation';
import ThemeChip from '@/shell/ThemeChip.vue';
import { AVAILABLE_THEMES, useThemeStore } from '@/state/theme';
import ConversationViewHost from './ConversationViewHost.vue';

const route = useRoute();
const router = useRouter();
const { t } = useI18n({ useScope: 'global' });
const themeStore = useThemeStore();
// The shipped logo is white-fill; a light theme gets the blue one, as the topbar does.
const logoSwBlue = logoSw.replace(/fill="#fff"/g, 'fill="#1368B3"');
const isLightAppearance = computed(() => AVAILABLE_THEMES.find((t) => t.id === themeStore.active)?.appearance === 'light');

const str = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '');
const conversation = computed(() => str(route.params.conversation));
const service = computed(() => str(route.query.service));
const instance = computed(() => str(route.query.instance));
const position = computed<PublicState>(() => ({
  ...(str(route.query.talk) ? { talk: str(route.query.talk) } : {}),
  ...(str(route.query.step) ? { step: str(route.query.step) } : {}),
  ...(str(route.query.stream) ? { stream: str(route.query.stream) } : {}),
}));

type Phase = 'reading' | 'ready' | 'error';
const phase = ref<Phase>('reading');
const bytes = ref(0);
const doc = ref<AszViewDocument | null>(null);
const failure = ref<{ title: string; detail: string | null } | null>(null);
let inFlight: AbortController | null = null;

const megabytes = computed(() => (bytes.value / 1_000_000).toFixed(bytes.value < 10_000_000 ? 1 : 0));
const title = computed(() => doc.value?.summary.title || t('(untitled)'));
const listRoute = computed(() => ({ path: '/layer/AI_AGENT/conversations' }));

function describe(err: unknown): { title: string; detail: string | null } {
  if (err instanceof AiConversationViewError) {
    const detail = err.detail;
    switch (err.kind) {
      case 'bad_request':
        return { title: t('The link is incomplete: it names no agent runtime.'), detail };
      case 'not_found':
        return { title: t('OAP holds no round of this conversation for this runtime.'), detail };
      case 'forbidden':
        return { title: t('Your role lacks the ai-conversation:read permission.'), detail: null };
      case 'timeout':
        return { title: t('OAP did not answer within its time budget. The conversation may be very large; try again.'), detail };
      case 'unreachable':
        return { title: t('OAP is unreachable.'), detail };
      case 'unsupported':
        return { title: t('This Horizon cannot read the document OAP sent.'), detail: err.message };
      case 'network':
        return { title: t('Cannot reach the server.'), detail };
      default:
        return { title: t('The conversation could not be read.'), detail: detail ?? err.message };
    }
  }
  return { title: t('The conversation could not be read.'), detail: err instanceof Error ? err.message : String(err) };
}

async function load(): Promise<void> {
  inFlight?.abort();
  const ctl = new AbortController();
  inFlight = ctl;
  phase.value = 'reading';
  bytes.value = 0;
  doc.value = null;
  failure.value = null;
  if (!conversation.value || !service.value) {
    failure.value = describe(new AiConversationViewError('bad_request', 400, 'service_required'));
    phase.value = 'error';
    return;
  }
  try {
    const r = await bff.aiConversation.view(
      conversation.value,
      { service: service.value, ...(instance.value ? { instance: instance.value } : {}) },
      { signal: ctl.signal, onProgress: (p) => (bytes.value = p.bytes) },
    );
    if (ctl.signal.aborted) return;
    if (!isSupportedDocument(r.document)) {
      throw new AiConversationViewError('unsupported', 200, t('This Horizon cannot read the document OAP sent.'));
    }
    doc.value = r.document;
    phase.value = 'ready';
  } catch (err) {
    if (ctl.signal.aborted) return;
    failure.value = describe(err);
    phase.value = 'error';
  }
}

/** The renderer's position goes into the URL in place, so the address bar is
 *  always the link to what is on screen. Compared against the query last
 *  written, not the route: a navigation is asynchronous, and two positions in
 *  quick succession would otherwise drop the second. */
let written: PublicState | null = null;
function onPosition(s: PublicState): void {
  const last = written ?? position.value;
  if ((last.talk ?? '') === (s.talk ?? '') && (last.step ?? '') === (s.step ?? '') && (last.stream ?? '') === (s.stream ?? '')) return;
  written = { ...s };
  const q: LocationQueryRaw = { ...route.query };
  for (const k of ['talk', 'step', 'stream'] as const) {
    if (s[k]) q[k] = s[k];
    else delete q[k];
  }
  void router.replace({ query: q });
}

watch(title, (v) => {
  document.title = phase.value === 'ready' ? `${v} · Horizon` : 'Horizon';
});
onMounted(() => {
  // Outside the AppShell nothing else loads the org's default theme.
  void themeStore.loadOrgDefault();
  void load();
});
watch([conversation, service, instance], () => void load());
onBeforeUnmount(() => {
  inFlight?.abort();
  document.title = 'Horizon';
});
</script>

<template>
  <div class="cvp">
    <header class="cvp-head">
      <router-link class="cvp-brand" to="/" :title="t('Back to Horizon')">
        <!-- eslint-disable-next-line vue/no-v-html -- build-time `?raw` import of a bundled SVG constant; no runtime input reaches it, and scripts/check-security.mjs scans the ?raw set for active content -->
        <span class="cvp-logo" v-html="isLightAppearance ? logoSwBlue : logoSw" />
      </router-link>
      <div class="cvp-title">
        <span class="cvp-kicker">{{ t('AI agent conversation') }}</span>
        <h1 :class="{ untitled: phase === 'ready' && !doc?.summary.title }">{{ phase === 'ready' ? title : conversation }}</h1>
        <span class="cvp-meta">
          <span class="cvp-mono">{{ service }}</span>
          <template v-if="instance"> · <span class="cvp-mono">{{ instance }}</span></template>
          <template v-if="phase === 'ready'"> · <span class="cvp-mono">{{ conversation }}</span></template>
        </span>
      </div>
      <div class="cvp-actions">
        <router-link class="sw-btn cvp-link" :to="listRoute">{{ t('All conversations') }}</router-link>
        <ThemeChip />
      </div>
    </header>

    <section v-if="phase === 'reading'" class="cvp-state" aria-live="polite">
      <strong>{{ t('Reading the conversation…') }}</strong>
      <span class="cvp-progress">{{ bytes > 0 ? t('{mb} MB received', { mb: megabytes }) : t('Waiting for OAP to assemble the conversation. A large one is quiet for a while before its first byte.') }}</span>
    </section>

    <section v-else-if="phase === 'error'" class="cvp-state err" role="alert">
      <strong>{{ failure?.title }}</strong>
      <code v-if="failure?.detail" class="cvp-detail">{{ failure.detail }}</code>
      <div class="cvp-state-actions">
        <button type="button" class="sw-btn" @click="load">{{ t('Try again') }}</button>
        <router-link class="sw-btn cvp-link" :to="listRoute">{{ t('All conversations') }}</router-link>
      </div>
    </section>

    <ConversationViewHost v-else-if="doc" :document="doc" :state="position" @update:state="onPosition" />
  </div>
</template>

<style scoped>
.cvp { display: flex; flex-direction: column; min-height: 100dvh; background: var(--sw-bg-0); color: var(--sw-fg-0); }
.cvp-head {
  display: flex; align-items: center; gap: 14px; min-height: 48px; padding: 6px 12px;
  border-bottom: 1px solid var(--sw-line); background: var(--sw-bg-1);
}
.cvp-brand { display: inline-flex; align-items: center; padding: 4px; border-radius: 6px; }
.cvp-brand:hover { background: var(--sw-bg-3); }
.cvp-logo { display: inline-flex; align-items: center; }
.cvp-logo :deep(svg) { width: auto; height: 20px; display: block; }
.cvp-title { display: flex; flex-direction: column; min-width: 0; flex: 1; line-height: 1.25; }
.cvp-kicker { color: var(--sw-fg-2); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
.cvp-title h1 { margin: 0; font-size: 14px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cvp-title h1.untitled { color: var(--sw-fg-2); font-weight: 500; }
.cvp-meta { color: var(--sw-fg-2); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cvp-mono { font-family: var(--sw-mono); }
.cvp-actions { display: flex; align-items: center; gap: 8px; }
.cvp-link { text-decoration: none; }
.cvp-state {
  display: flex; flex-direction: column; align-items: center; gap: 8px; margin: 18vh auto 0; max-width: 560px; padding: 24px;
  border: 1px solid var(--sw-line); border-radius: 8px; background: var(--sw-bg-1); color: var(--sw-fg-1); text-align: center;
}
.cvp-state strong { color: var(--sw-fg-0); font-size: 14px; }
.cvp-state.err { border-color: color-mix(in srgb, var(--sw-err) 45%, transparent); }
.cvp-progress { font-variant-numeric: tabular-nums; }
.cvp-detail { max-width: 100%; padding: 6px 8px; border-radius: 4px; background: var(--sw-bg-2); color: var(--sw-fg-1); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; text-align: left; }
.cvp-state-actions { display: flex; gap: 8px; margin-top: 6px; }
</style>
