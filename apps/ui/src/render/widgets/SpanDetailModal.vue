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
  Span-detail modal — meta, cross-trace refs, tags, logs and attached
  events for a single span. Opened by clicking a row / tree node in the
  trace-detail card. Cross-trace refs route through openTrace() → the
  global popout.

  Props:
    span          — the span to render.
    traceId       — the active trace id; cross-trace refs are the refs
                    whose traceId differs from it.
    serviceColors — the card's service → colour map, so the swatch
                    matches the legend.

  Emits:
    close         — the × / backdrop click closed the modal.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { NativeSpan, TraceAttachedEvent, TraceLogEntry } from '@/api/client';
import { useTracePopout } from '@/layer/traces/useTracePopout';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import {
  serviceColorFrom, kindColor, fmtMs, fmtDateTime, fmtAttachedTs,
} from './traceDetailShared';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  span: NativeSpan;
  traceId: string | null;
  serviceColors: Map<string, string>;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { openTrace } = useTracePopout();

useEscapeToClose(() => true, () => emit('close'));

function serviceColor(c: string): string { return serviceColorFrom(props.serviceColors, c); }
function nativeSpanError(s: NativeSpan): boolean { return s.isError; }
</script>

<template>
  <div class="span-modal-backdrop" @click.self="$emit('close')">
    <article class="span-modal sw-card">
      <header class="span-modal-head">
        <h4>
          <span class="dim">{{ t('Span detail') }}</span>
          <span class="mono">{{ span.endpointName || '—' }}</span>
        </h4>
        <button class="sw-btn small ghost" type="button" @click="$emit('close')">×</button>
      </header>
      <div class="span-modal-body">
        <section class="sd-section">
          <h5>{{ t('Meta') }}</h5>
          <dl class="kv">
            <dt>{{ t('Service') }}</dt>
            <dd class="mono" :style="{ color: serviceColor(span.serviceCode) }">
              <span class="svc-swatch inline" :style="{ background: serviceColor(span.serviceCode) }" />
              {{ span.serviceCode }}
            </dd>
            <dt>{{ t('Instance') }}</dt><dd class="mono">{{ span.serviceInstanceName }}</dd>
            <dt>{{ t('Endpoint') }}</dt><dd class="mono">{{ span.endpointName || '—' }}</dd>
            <dt>{{ t('Kind') }}</dt><dd><span class="tr-kind" :style="{ color: kindColor(span.type) }">{{ span.type }}</span></dd>
            <dt>{{ t('Component') }}</dt><dd class="mono">{{ span.component || '—' }}</dd>
            <dt>{{ t('Peer') }}</dt><dd class="mono">{{ span.peer || '—' }}</dd>
            <dt>{{ t('Layer') }}</dt><dd class="mono dim">{{ span.layer || '—' }}</dd>
            <dt>{{ t('Start') }}</dt><dd class="mono">{{ fmtDateTime(span.startTime) }}</dd>
            <dt>{{ t('Duration') }}</dt><dd class="mono">{{ fmtMs(span.endTime - span.startTime) }}</dd>
            <dt>{{ t('Error') }}</dt><dd><span class="status-flag" :class="nativeSpanError(span) ? 'flag-err' : 'flag-ok'"><span class="flag-dot" />{{ nativeSpanError(span) ? t('true') : t('false') }}</span></dd>
          </dl>
        </section>
        <section
          v-if="(span.refs ?? []).some((r) => r.traceId !== traceId)"
          class="sd-section"
        >
          <h5>{{ t('Cross-trace refs') }}</h5>
          <table class="kv-table">
            <thead><tr><th>{{ t('Trace ID') }}</th><th>{{ t('Parent segment') }}</th><th class="num">{{ t('Parent span') }}</th><th>{{ t('Ref type') }}</th></tr></thead>
            <tbody>
              <template v-for="(r, i) in span.refs" :key="i">
                <tr v-if="r.traceId !== traceId">
                  <td>
                    <button class="trace-link mono" type="button" @click="openTrace(r.traceId)">{{ r.traceId }} ↗</button>
                  </td>
                  <td class="mono dim">{{ r.parentSegmentId }}</td>
                  <td class="num mono">{{ r.parentSpanId }}</td>
                  <td class="mono dim">{{ r.type }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </section>
        <section v-if="span.tags && span.tags.length > 0" class="sd-section">
          <h5>{{ t('Tags') }}</h5>
          <dl class="kv">
            <template v-for="(tag, i) in span.tags" :key="i">
              <dt class="mono">{{ tag.key }}</dt>
              <dd class="mono wba">{{ tag.value }}</dd>
            </template>
          </dl>
        </section>
        <section v-if="span.logs && span.logs.length > 0" class="sd-section">
          <h5>{{ t('Logs') }}</h5>
          <div v-for="(log, i) in (span.logs as TraceLogEntry[])" :key="i" class="span-log">
            <div class="span-log-time mono dim">{{ fmtDateTime(log.time) }}</div>
            <dl class="kv">
              <template v-for="(d, j) in log.data" :key="j">
                <dt class="mono">{{ d.key }}</dt>
                <dd><pre class="mono pre wba">{{ d.value }}</pre></dd>
              </template>
            </dl>
          </div>
        </section>
        <section v-if="span.attachedEvents && span.attachedEvents.length > 0" class="sd-section">
          <h5>{{ t('Attached Events') }}</h5>
          <div v-for="(ev, i) in (span.attachedEvents as TraceAttachedEvent[])" :key="i" class="span-event">
            <div class="span-event-head">
              <span class="mono">{{ ev.event }}</span>
              <span class="dim mono">{{ fmtAttachedTs(ev.startTime) }} → {{ fmtAttachedTs(ev.endTime) }}</span>
            </div>
            <dl v-if="ev.summary && ev.summary.length > 0" class="kv">
              <template v-for="(s, j) in ev.summary" :key="`s${j}`">
                <dt class="mono">{{ s.key }}</dt>
                <dd class="mono wba">{{ s.value }}</dd>
              </template>
            </dl>
            <dl v-if="ev.tags && ev.tags.length > 0" class="kv">
              <template v-for="(tag, j) in ev.tags" :key="`t${j}`">
                <dt class="mono dim">{{ t('tag') }} · {{ tag.key }}</dt>
                <dd class="mono wba">{{ tag.value }}</dd>
              </template>
            </dl>
          </div>
        </section>
      </div>
    </article>
  </div>
</template>

<style scoped>
.mono { font-family: var(--sw-mono); }
.dim { color: var(--sw-fg-3); }
.wba { word-break: break-all; }
.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); }

.svc-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}
.svc-swatch.inline {
  display: inline-block;
  margin-right: 4px;
  vertical-align: middle;
}

/* Status flag */
.status-flag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  flex: 0 0 auto;
}
.flag-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: 0 0 auto;
}
.status-flag.flag-ok { background: rgba(34, 197, 94, 0.14); color: var(--sw-ok); }
.status-flag.flag-err { background: rgba(239, 68, 68, 0.18); color: var(--sw-err); }

/* Span detail modal */
.span-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 20px;
  overflow-y: auto;
}
.span-modal {
  width: 100%;
  max-width: 920px;
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
}
.span-modal-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
}
.span-modal-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  gap: 10px;
  align-items: baseline;
  flex: 1;
  min-width: 0;
}
.span-modal-head h4 .dim { color: var(--sw-fg-3); font-weight: 500; }
.span-modal-head h4 .mono {
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.span-modal-body { padding: 12px 14px 16px; overflow-y: auto; }
.sd-section { margin-bottom: 18px; }
.sd-section h5 {
  margin: 0 0 6px;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-accent);
  font-weight: 700;
}
.kv {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 11px;
}
.kv dt { color: var(--sw-fg-3); font-size: 10.5px; }
.kv dd { margin: 0; color: var(--sw-fg-1); }
.kv-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.kv-table th {
  text-align: left;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  font-weight: 600;
  padding: 4px 8px;
  border-bottom: 1px solid var(--sw-line);
}
.kv-table th.num { text-align: right; }
.kv-table td { padding: 4px 8px; border-bottom: 1px solid var(--sw-line); }
.kv-table td.num { text-align: right; }
.trace-link {
  background: transparent;
  border: none;
  color: var(--sw-cyan);
  cursor: pointer;
  padding: 0;
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.trace-link:hover { color: var(--sw-accent); }
.span-log, .span-event {
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 6px 10px;
  margin-bottom: 6px;
  background: var(--sw-bg-1);
}
.span-log-time { font-size: 10px; margin-bottom: 4px; }
.span-event-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  margin-bottom: 4px;
}
.pre {
  background: var(--sw-bg-2);
  padding: 4px 6px;
  border-radius: 3px;
  font-size: 10.5px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--sw-fg-1);
}
</style>
