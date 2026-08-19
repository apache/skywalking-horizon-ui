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
 * The `ui://` app: Horizon's cards, drawn inside an MCP host.
 *
 * It renders through the SAME components the chat panel uses — one dispatch
 * over the card kind, mounting `ChatFigureBlock`, `ChatTopologyBlock` and the
 * rest. That is the whole point of the frozen-snapshot design: a card already
 * carries everything needed to draw it, so an isolated sandbox with no network
 * at all can render exactly what the panel renders.
 *
 * Zero network requests. The bundle is self-contained, every card is a
 * captured replay, and nothing here fetches — so the host's deny-all default
 * CSP is satisfied without Horizon declaring a single exception.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { GraphicCard } from './card';
import { toBlock } from './card';
import ChatFigureBlock from '@/ai/ChatFigureBlock.vue';
import ChatProposalBlock from '@/ai/ChatProposalBlock.vue';
import ChatProfilingBlock from '@/ai/ChatProfilingBlock.vue';
import ChatProcessTopologyBlock from '@/ai/ChatProcessTopologyBlock.vue';
import ChatPodLogsBlock from '@/ai/ChatPodLogsBlock.vue';
import ChatHierarchyBlock from '@/ai/ChatHierarchyBlock.vue';
import ChatTopologyBlock from '@/ai/ChatTopologyBlock.vue';
import ChatDeploymentBlock from '@/ai/ChatDeploymentBlock.vue';
import ChatInstanceTopologyBlock from '@/ai/ChatInstanceTopologyBlock.vue';
import ChatEndpointDependencyBlock from '@/ai/ChatEndpointDependencyBlock.vue';
import ChatTracesBlock from '@/ai/ChatTracesBlock.vue';
import ChatZipkinTracesBlock from '@/ai/ChatZipkinTracesBlock.vue';
import ChatLogsBlock from '@/ai/ChatLogsBlock.vue';
import ChatBrowserErrorsBlock from '@/ai/ChatBrowserErrorsBlock.vue';

const cards = ref<GraphicCard[]>([]);
const root = ref<HTMLElement | null>(null);
const blocks = computed(() => cards.value.map(toBlock));

/**
 * A record of what this host actually did, shown in place of the empty state.
 *
 * The failure this exists for is silent by construction: an incomplete
 * handshake means the host never speaks, so the frame sits at "waiting" with
 * nothing anywhere to say why. A sandbox has no console anyone reads and no
 * network to report over — so the card reports on itself. Which conventions
 * were tried, what arrived, and where the payload was found or wasn't.
 */
const trace = ref<string[]>([]);
const note = (m: string): void => {
  trace.value.push(`${String(trace.value.length + 1).padStart(2, '0')}  ${m}`);
};

/**
 * The host handshake (MCP Apps, SEP-1865).
 *
 * A REQUEST/RESPONSE pair followed by a notification — not a ping, which is
 * what this used to send. The spec is explicit that the host stays silent
 * until the view says it is ready: "The Host MUST NOT send any request or
 * notification to the View before it receives an `initialized` notification."
 * So an incomplete handshake does not degrade, it hangs: the frame mounts and
 * waits forever, showing the empty state below.
 *
 *   1. view → host   ui/initialize            REQUEST (needs an id)
 *   2. host → view   {id, result}             a RESPONSE — no `method` field
 *   3. view → host   ui/notifications/initialized
 *   4. host → view   ui/notifications/tool-input, then …/tool-result
 *
 * A second convention exists (ChatGPT's `window.openai` globals). Which one
 * any given host speaks is not always knowable — Codex's bridge is closed
 * source — so both are supported and feature-detected rather than assumed.
 */
type Rpc = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

const CARDS_KEY = 'org.apache.skywalking.horizon/cards';
const PROTOCOL_VERSION = '2026-01-26';
const INIT_ID = 1;

/** Cards from a CallToolResult, wherever this host actually put them.
 *
 *  `_meta` is the spec's widget-only channel and carries the FULL payload;
 *  `structuredContent` is the portable fallback, because OpenAI hosts have a
 *  known defect stripping `_meta` and their own guidance is not to depend on
 *  it alone. Preferring `_meta` means the richer copy wins where it survives. */
function readCards(res: Record<string, unknown> | undefined): GraphicCard[] | null {
  if (!res) return null;
  const meta = res._meta as Record<string, unknown> | undefined;
  const structured = res.structuredContent as Record<string, unknown> | undefined;
  const from: Array<[string, unknown]> = [
    ['_meta', meta?.[CARDS_KEY]],
    ['structuredContent', structured?.[CARDS_KEY]],
    ['structuredContent.cards', structured?.cards],
  ];
  note(`payload channels: ${from.map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : 'none'}`).join(' ')}`);
  for (const [where, raw] of from) {
    if (Array.isArray(raw) && raw.length) {
      note(`cards read from ${where}: ${(raw as GraphicCard[]).map((c) => c.type).join(', ')}`);
      return raw as GraphicCard[];
    }
  }
  return null;
}

function post(msg: Record<string, unknown>): void {
  window.parent?.postMessage({ jsonrpc: '2.0', ...msg }, '*');
}

function onMessage(ev: MessageEvent): void {
  const msg = ev.data as Rpc | undefined;
  if (!msg || typeof msg !== 'object') return;

  // The initialize RESPONSE: identified by our id, and it carries no `method`.
  if (msg.id === INIT_ID && msg.result && !msg.method) {
    note('host answered ui/initialize → sending initialized');
    post({ method: 'ui/notifications/initialized' });
    return;
  }
  // The host may ping; the SDK answers this for you, a hand-rolled listener
  // must do it itself or the host may consider the view dead.
  if (msg.method === 'ping' && msg.id !== undefined) {
    post({ id: msg.id, result: {} });
    return;
  }
  // Teardown is a request the host waits on before removing the frame.
  if (msg.method === 'ui/resource-teardown' && msg.id !== undefined) {
    post({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'ui/notifications/tool-result') {
    note('tool-result arrived');
    const next = readCards(msg.params);
    if (next) cards.value = next;
    else note('tool-result carried no cards in any known channel');
    return;
  }
  if (msg.method) note(`host → ${msg.method}`);
}

/**
 * ChatGPT's alternative: globals rather than messages. They are not guaranteed
 * to exist when this script first runs, which is why OpenAI's own hook polls —
 * 250 ms, forty attempts — alongside its event subscription. Mirrored here.
 */
let openaiPoll: ReturnType<typeof setInterval> | null = null;

/**
 * `toolResponseMetadata` is a WRAPPER, not the result's `_meta`.
 *
 * It holds the tool result under `mcp_tool_result` / `call_tool_result`, so
 * handing it straight over as `_meta` finds nothing and the read falls through
 * to `toolOutput` — the deliberately slimmed copy, which has trace spans
 * removed. The waterfall then has nothing to draw, on the one host this
 * fallback exists for. Both wrapper keys are tried, and the bare object last,
 * because hosts have shipped all three shapes.
 */
function unwrapToolResponse(raw: unknown): Record<string, unknown> | undefined {
  const w = raw as Record<string, unknown> | undefined;
  if (!w) return undefined;
  const inner = (w.mcp_tool_result ?? w.call_tool_result) as Record<string, unknown> | undefined;
  if (inner) return (inner._meta as Record<string, unknown> | undefined) ?? inner;
  return w;
}

function readOpenAiGlobals(): boolean {
  const g = (window as unknown as { openai?: Record<string, unknown> }).openai;
  if (!g) return false;
  const next = readCards({
    _meta: unwrapToolResponse(g.toolResponseMetadata),
    structuredContent: g.toolOutput,
  } as Record<string, unknown>);
  if (next) {
    cards.value = next;
    return true;
  }
  return false;
}

function onSetGlobals(): void {
  readOpenAiGlobals();
}

/**
 * Tell the host how tall this actually is, whenever that changes.
 *
 * The iframe is sized by the host, which can only guess before anything has
 * rendered — and what renders here changes drastically: a one-line "reading
 * data" placeholder is replaced by a topology, a log table or a trace
 * waterfall. Without a report the host keeps its first guess, so the card is
 * either clipped or scrolls inside a box that looks like the whole answer.
 *
 * Sent both ways because hosts disagree on which they listen for, and an
 * unrecognised notification is ignored rather than harmful. Deduplicated on the
 * rounded height: a ResizeObserver fires on sub-pixel reflow, and a chart that
 * settles over several frames would otherwise post a burst of near-identical
 * messages.
 */
let sizeObserver: ResizeObserver | null = null;
let lastHeight = 0;

function reportHeight(px: number): void {
  const h = Math.ceil(px);
  if (h <= 0 || h === lastHeight) return;
  lastHeight = h;
  post({ method: 'ui/notifications/size-changed', params: { height: h } });
  const g = (window as unknown as { openai?: { notifyIntrinsicHeight?: (n: number) => void } }).openai;
  g?.notifyIntrinsicHeight?.(h);
}

onMounted(() => {
  // Handlers BEFORE the handshake: the host may answer immediately, and a
  // listener registered afterwards misses its own initialize response.
  window.addEventListener('message', onMessage);
  window.addEventListener('openai:set_globals', onSetGlobals as EventListener);

  note(`in an iframe: ${window.parent !== window} · window.openai: ${'openai' in window}`);
  note('sent ui/initialize (request)');
  post({
    id: INIT_ID,
    method: 'ui/initialize',
    params: {
      appInfo: { name: 'Horizon cards', version: '1.0.0' },
      appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
      protocolVersion: PROTOCOL_VERSION,
    },
  });

  // Report the height now and on every reflow. `documentElement` as the
  // fallback because the root ref is what the host actually sees only when the
  // template has mounted, and the first report should not wait for a card.
  const target = root.value ?? document.documentElement;
  reportHeight(target.getBoundingClientRect().height);
  sizeObserver = new ResizeObserver((entries) => {
    for (const e of entries) reportHeight(e.contentRect.height || (e.target as HTMLElement).offsetHeight);
  });
  sizeObserver.observe(target);

  if (!readOpenAiGlobals()) {
    let left = 40;
    openaiPoll = setInterval(() => {
      if (readOpenAiGlobals() || --left <= 0) {
        if (openaiPoll) clearInterval(openaiPoll);
        openaiPoll = null;
      }
    }, 250);
  }
});

onUnmounted(() => {
  window.removeEventListener('message', onMessage);
  window.removeEventListener('openai:set_globals', onSetGlobals as EventListener);
  if (openaiPoll) clearInterval(openaiPoll);
  sizeObserver?.disconnect();
  sizeObserver = null;
});
</script>

<template>
  <div ref="root" class="mcp-app">
    <template v-for="(b, i) in blocks" :key="i">
      <ChatFigureBlock v-if="b.kind === 'figure'" :block="b" />
      <ChatProposalBlock v-else-if="b.kind === 'proposal'" :block="b" />
      <ChatProfilingBlock v-else-if="b.kind === 'profiling'" :n="b.n" :spec="b.spec" :captured-at="b.capturedAt" />
      <ChatProcessTopologyBlock v-else-if="b.kind === 'process-topology'" :n="b.n" :spec="b.spec" :captured-at="b.capturedAt" />
      <ChatPodLogsBlock v-else-if="b.kind === 'podlogs'" :n="b.n" :spec="b.spec" :captured-at="b.capturedAt" />
      <ChatHierarchyBlock v-else-if="b.kind === 'hierarchy'" :n="b.n" :spec="b.spec" :captured-at="b.capturedAt" />
      <ChatTopologyBlock v-else-if="b.kind === 'topology'" :n="b.n" :spec="b.spec" :captured-at="b.capturedAt" />
      <ChatDeploymentBlock v-else-if="b.kind === 'deployment'" :n="b.n" :spec="b.spec" :captured-at="b.capturedAt" />
      <ChatInstanceTopologyBlock v-else-if="b.kind === 'instance-topology'" :n="b.n" :spec="b.spec" :captured-at="b.capturedAt" />
      <ChatEndpointDependencyBlock v-else-if="b.kind === 'endpoint-dependency'" :n="b.n" :spec="b.spec" :captured-at="b.capturedAt" />
      <ChatTracesBlock v-else-if="b.kind === 'traces'" :n="b.n" :spec="b.spec" :captured-at="b.capturedAt" />
      <ChatZipkinTracesBlock v-else-if="b.kind === 'zipkin-traces'" :n="b.n" :spec="b.spec" :captured-at="b.capturedAt" />
      <ChatLogsBlock v-else-if="b.kind === 'logs'" :n="b.n" :spec="b.spec" :captured-at="b.capturedAt" />
      <ChatBrowserErrorsBlock v-else-if="b.kind === 'browser-errors'" :n="b.n" :spec="b.spec" :captured-at="b.capturedAt" />
    </template>
    <!-- Not a spinner: if the payload never arrives, the card is the only
         place a diagnosis can appear. -->
    <section v-if="!blocks.length" class="waiting">
      <p class="waiting-title">Waiting for data from the host…</p>
      <pre class="waiting-trace">{{ trace.join('\n') }}</pre>
      <p class="waiting-foot">
        Horizon sends cards in both <code>_meta</code> and <code>structuredContent</code>.
        If nothing is listed above, this host has not completed the MCP Apps handshake.
      </p>
    </section>
  </div>
</template>

<style scoped>
.mcp-app {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px;
}
.waiting {
  padding: 16px;
  color: var(--sw-fg-2);
  font-size: 12px;
}
.waiting-title {
  margin: 0 0 10px;
  font-weight: 600;
  color: var(--sw-fg-1);
}
.waiting-trace {
  margin: 0 0 10px;
  padding: 10px;
  border-radius: 6px;
  background: rgb(255 255 255 / 4%);
  border: 1px solid rgb(255 255 255 / 8%);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-x: auto;
}
.waiting-foot {
  margin: 0;
  line-height: 1.6;
}
</style>
