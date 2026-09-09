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
  BFF and shows the wait in phases — OAP folding the chain (nothing arrives),
  the bytes coming in against the size the BFF states, the parse, the draw —
  then hands it to the shared renderer.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { isSupportedDocument, type AszViewDocument, type PublicState } from '@skywalking-horizon-ui/conversation-view';
import type { AiConversationDocumentSummary } from '@skywalking-horizon-ui/api-client';
import ProgressBar from '@/components/primitives/ProgressBar.vue';
import { currentLocale } from '@/i18n';
import logoSw from '@/assets/icons/logo-sw.svg?raw';
import { bff } from '@/api/client';
import { AiConversationViewError } from '@/api/scopes/ai-conversation';
import LocaleChip from '@/shell/LocaleChip.vue';
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

/** The wait, in the order it happens: OAP folding the chain (nothing arrives),
 *  the bytes coming in, the parse, the draw. */
type Phase = 'assembling' | 'receiving' | 'parsing' | 'drawing' | 'ready' | 'error';
const phase = ref<Phase>('assembling');
const bytes = ref(0);
const total = ref<number | null>(null);
const summary = ref<AiConversationDocumentSummary | null>(null);
const elapsedS = ref(0);
const rate = ref<number | null>(null); // decoded bytes per second, over the transfer so far
const doc = ref<AszViewDocument | null>(null);
const failure = ref<{ title: string; detail: string | null } | null>(null);
let inFlight: AbortController | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let startedAt = 0;
let firstByteAt = 0;

const mb = (n: number): string => new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(n / 1_000_000);
const count = (n: number): string => new Intl.NumberFormat(currentLocale()).format(n);
const fraction = computed<number | null>(() => {
  if (phase.value === 'parsing' || phase.value === 'drawing') return 1;
  if (phase.value === 'receiving' && total.value) return Math.min(1, bytes.value / total.value);
  return null;
});
const percent = computed(() => (fraction.value === null ? null : Math.round(fraction.value * 100)));
const secondsLeft = computed<number | null>(() => {
  if (phase.value !== 'receiving' || !total.value || !rate.value || Date.now() - firstByteAt < 1500) return null;
  return Math.max(1, Math.round((total.value - bytes.value) / rate.value));
});
const countsLine = computed(() =>
  summary.value
    ? t('{talks} talks · {steps} steps · {streams} streams, as OAP counted them.', {
        talks: count(summary.value.talks),
        steps: count(summary.value.steps),
        streams: count(summary.value.streams),
      })
    : '',
);

function stopTicker(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}
/** Two frames, so what was just set is painted before a long synchronous
 *  step (the parse, the draw) blocks the page. */
async function painted(): Promise<void> {
  await nextTick();
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
const title = computed(() => doc.value?.summary.title || t('(untitled)'));
const listRoute = computed(() => ({ path: '/layer/AI_AGENT/conversations' }));

function describe(err: unknown): { title: string; detail: string | null } {
  if (err instanceof AiConversationViewError) {
    const detail = err.detail;
    switch (err.kind) {
      case 'bad_request':
        return { title: t('The link is incomplete: it names no agent.'), detail };
      case 'not_found':
        return { title: t('OAP holds no round of this conversation for this agent.'), detail };
      case 'not_served':
        return { title: t('This OAP does not serve conversation documents; the AI agent conversation module needs OAP 11.1.0 or later.'), detail: null };
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
  stopTicker();
  const ctl = new AbortController();
  inFlight = ctl;
  phase.value = 'assembling';
  bytes.value = 0;
  total.value = null;
  summary.value = null;
  rate.value = null;
  elapsedS.value = 0;
  doc.value = null;
  failure.value = null;
  startedAt = Date.now();
  firstByteAt = 0;
  ticker = setInterval(() => {
    elapsedS.value = Math.round((Date.now() - startedAt) / 1000);
  }, 1000);
  if (!conversation.value || !service.value) {
    failure.value = describe(new AiConversationViewError('bad_request', 400, 'service_required'));
    phase.value = 'error';
    return;
  }
  try {
    const r = await bff.aiConversation.view(
      conversation.value,
      { service: service.value, ...(instance.value ? { instance: instance.value } : {}) },
      {
        signal: ctl.signal,
        onProgress: (p) => {
          if (ctl.signal.aborted) return;
          if (!firstByteAt) firstByteAt = Date.now();
          bytes.value = p.bytes;
          total.value = p.total;
          summary.value = p.summary;
          const seconds = (Date.now() - firstByteAt) / 1000;
          rate.value = seconds > 0.2 ? p.bytes / seconds : null;
          phase.value = p.phase;
        },
      },
    );
    if (ctl.signal.aborted) return;
    if (!isSupportedDocument(r.document)) {
      throw new AiConversationViewError('unsupported', 200, t('This Horizon cannot read the document OAP sent.'));
    }
    stopTicker();
    phase.value = 'drawing';
    await painted();
    if (ctl.signal.aborted) return;
    doc.value = r.document;
    phase.value = 'ready';
  } catch (err) {
    if (ctl.signal.aborted) return;
    stopTicker();
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
  stopTicker();
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
        <LocaleChip />
      </div>
    </header>

    <section v-if="phase !== 'ready' && phase !== 'error'" class="cvp-state" aria-live="polite">
      <strong>{{ phase === 'drawing' ? t('Drawing the conversation…') : t('Reading the conversation…') }}</strong>
      <ProgressBar :value="fraction" :label="t('Reading the conversation…')" />
      <div class="cvp-line">
        <template v-if="phase === 'assembling'">
          <span>{{ t('OAP is assembling the conversation') }}</span>
          <span class="cvp-num">{{ t('{s} s', { s: elapsedS }) }}</span>
        </template>
        <template v-else-if="phase === 'receiving'">
          <span v-if="total">
            <span class="cvp-num">{{ t('{n} of {m} MB received', { n: mb(bytes), m: mb(total) }) }}</span>
            <template v-if="percent !== null"> · <b>{{ percent }}%</b></template>
          </span>
          <span v-else class="cvp-num">{{ t('{mb} MB received', { mb: mb(bytes) }) }}</span>
          <span class="cvp-num cvp-faint">
            <template v-if="rate">{{ t('{rate} MB/s', { rate: mb(rate) }) }}</template>
            <template v-if="secondsLeft !== null"> · {{ t('about {s} s left', { s: secondsLeft }) }}</template>
          </span>
        </template>
        <template v-else>
          <span><span class="cvp-num">{{ t('{mb} MB received', { mb: mb(bytes) }) }}</span> · <b>100%</b></span>
          <span class="cvp-faint">{{ phase === 'parsing' ? t('parsing') : t('drawing') }}</span>
        </template>
      </div>
      <span class="cvp-sub">
        <template v-if="phase === 'assembling'">{{ t('Nothing arrives until OAP has folded the whole chain.') }}</template>
        <template v-else-if="phase === 'drawing' && summary">{{ t('Laying out {talks} talks and {steps} steps.', { talks: count(summary.talks), steps: count(summary.steps) }) }}</template>
        <template v-else>{{ countsLine }}</template>
      </span>
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
/* Exactly the viewport: the renderer fills what the header leaves, and only its
   panels scroll. `auto` rather than `hidden` so a viewport shorter than the
   workbench's floor can still reach the bottom. */
.cvp { display: flex; flex-direction: column; height: 100dvh; overflow: auto; background: var(--sw-bg-0); color: var(--sw-fg-0); }
.cvp-head { flex: none; }
@media (max-width: 860px) {
  .cvp { height: auto; min-height: 100dvh; overflow: visible; }
}
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
  display: flex; flex-direction: column; align-items: stretch; gap: 10px; width: min(620px, calc(100% - 32px)); margin: 18vh auto 0; padding: 20px 22px;
  border: 1px solid var(--sw-line); border-radius: 8px; background: var(--sw-bg-1); color: var(--sw-fg-1);
}
.cvp-state strong { color: var(--sw-fg-0); font-size: 14px; }
.cvp-state.err { align-items: center; text-align: center; border-color: color-mix(in srgb, var(--sw-err) 45%, transparent); }
.cvp-line { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-size: 12px; }
.cvp-line b { color: var(--sw-fg-0); font-weight: 650; }
.cvp-num { font-variant-numeric: tabular-nums; color: var(--sw-fg-0); }
.cvp-faint { color: var(--sw-fg-2); }
.cvp-sub { min-height: 1.4em; color: var(--sw-fg-2); font-size: 11px; line-height: 1.45; }
.cvp-detail { max-width: 100%; padding: 6px 8px; border-radius: 4px; background: var(--sw-bg-2); color: var(--sw-fg-1); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; text-align: left; }
.cvp-state-actions { display: flex; gap: 8px; margin-top: 6px; }
</style>
