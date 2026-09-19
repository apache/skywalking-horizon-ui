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
  One OTLP span, in OTLP's own terms.

  The fields are the protocol's: trace and span ids, the parent span id, the
  kind enum, a three-valued status with its message, the start and end times,
  and — kept apart, because OTLP keeps them apart and they answer different
  questions — the RESOURCE attributes (who emitted this), the instrumentation
  SCOPE (what produced it), the SPAN attributes (what happened), and the
  EVENTS with their own attributes.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { TraceQLSpan } from '@skywalking-horizon-ui/api-client';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import { fmtDateTime, fmtMs, kindColor, kindLabel, otlpKindName, statusColor } from './traceqlDetailShared';
import LongValue from '@/components/primitives/LongValue.vue';

defineProps<{ span: TraceQLSpan; traceId: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const { t } = useI18n({ useScope: 'global' });
useEscapeToClose(
  () => true,
  () => emit('close'),
);
</script>

<template>
  <div class="tqm-backdrop" @click.self="emit('close')">
    <div class="tqm sw-card" role="dialog" aria-modal="true">
      <header class="tqm-head">
        <h4>
          <span class="dim">{{ t('Span detail') }}</span>
          <span class="mono">{{ span.name || '—' }}</span>
        </h4>
        <span class="tqm-kind mono">{{ kindLabel(span.kind) }}</span>
        <span class="tqm-status mono" :style="{ color: statusColor(span.status) }">{{ span.status }}</span>
        <button type="button" class="sw-btn small ghost tqm-close" @click="emit('close')">×</button>
      </header>

      <!-- One grid for the span's own fields and both attribute blocks, so the
           value column starts at the same place in all three. Each block keeps
           its own <dl> for semantics and joins the grid with display:contents. -->
      <div class="tqm-fields">
      <section>
        <h5>{{ t('Meta') }}</h5>
      </section>
      <dl class="tqm-kv">
        <dt>{{ t('Service') }}</dt><dd class="mono">{{ span.service || '—' }}</dd>
        <dt>{{ t('Kind') }}</dt>
        <dd>
          <span :style="{ color: kindColor(span.kind) }">{{ kindLabel(span.kind) }}</span>
          <!-- The kind the label was read from, for anyone working in OTLP's
               own terms. -->
          <span class="tqm-kind-raw mono">· {{ otlpKindName(span.kind) }}</span>
        </dd>
        <dt>{{ t('Duration') }}</dt><dd class="mono">{{ fmtMs(span.durationUs) }}</dd>
        <dt>{{ t('Started') }}</dt><dd class="mono">{{ fmtDateTime(span.startUs) }}</dd>
        <dt>{{ t('Ended') }}</dt><dd class="mono">{{ fmtDateTime(span.startUs + span.durationUs) }}</dd>
        <dt>{{ t('Trace ID') }}</dt><dd class="mono break">{{ traceId }}</dd>
        <dt>{{ t('Span ID') }}</dt><dd class="mono break">{{ span.spanId }}</dd>
        <dt>{{ t('Parent span ID') }}</dt><dd class="mono break">{{ span.parentSpanId || '—' }}</dd>
        <template v-if="span.statusMessage">
          <dt>{{ t('Status message') }}</dt><dd class="mono break err">{{ span.statusMessage }}</dd>
        </template>
        <template v-if="span.scopeName">
          <dt>{{ t('Scope') }}</dt>
          <dd class="mono">{{ span.scopeName }}{{ span.scopeVersion ? ` ${span.scopeVersion}` : '' }}</dd>
        </template>
      </dl>

      <section v-if="span.resourceAttributes.length">
        <h5>{{ t('Resource attributes') }}</h5>
        <dl class="tqm-kv">
          <template v-for="a in span.resourceAttributes" :key="a.key">
            <dt class="mono">{{ a.key }}</dt>
            <dd class="mono break"><LongValue :value="a.value" :label="a.key" /></dd>
          </template>
        </dl>
      </section>

      <section v-if="span.attributes.length">
        <h5>{{ t('Span attributes') }}</h5>
        <dl class="tqm-kv">
          <template v-for="a in span.attributes" :key="a.key">
            <dt class="mono">{{ a.key }}</dt>
            <dd class="mono break"><LongValue :value="a.value" :label="a.key" /></dd>
          </template>
        </dl>
      </section>
      </div>

      <section v-if="span.events.length">
        <h5>{{ t('Events') }}</h5>
        <ul class="tqm-events">
          <li v-for="(ev, i) in span.events" :key="i">
            <div class="tqm-event-head mono">
              <span>{{ ev.name || '—' }}</span>
              <span class="dim">{{ fmtDateTime(ev.timeUs) }}</span>
            </div>
            <dl v-if="ev.attributes.length" class="tqm-kv nested">
              <template v-for="a in ev.attributes" :key="a.key">
                <dt class="mono">{{ a.key }}</dt>
                <dd class="mono break"><LongValue :value="a.value" :label="a.key" /></dd>
              </template>
            </dl>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.tqm-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 45;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
}
.tqm { width: min(720px, 100%); max-height: 82vh; overflow: auto; padding: 12px 14px; }
.tqm-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.tqm-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  gap: 10px;
  align-items: baseline;
  min-width: 0;
}
.tqm-head h4 .dim { color: var(--sw-fg-3); font-weight: 500; }
.tqm-head h4 .mono { font-family: var(--sw-mono); color: var(--sw-fg-1); overflow-wrap: anywhere; }
.tqm-kind { font-size: 10.5px; color: var(--sw-fg-3); }
.tqm-kind-raw { margin-left: 8px; font-size: 10px; color: var(--sw-fg-3); }
.tqm-status { font-size: 10.5px; }
.tqm-close { margin-left: auto; }
.tqm-fields {
  display: grid;
  grid-template-columns: max-content 1fr;
  /* The native span dialog's key column and type scale, so a field reads the
     same whichever trace store it came from. */
  grid-template-columns: 160px 1fr;
  gap: 4px 12px;
  align-items: baseline;
  margin: 6px 0;
  font-size: 11px;
}
/* The blocks are containers for meaning, not for layout: dissolving their
   boxes puts every key and value in the ONE grid above, which is what makes a
   single key column wide enough for all of them. */
.tqm-fields > dl,
.tqm-fields > section,
.tqm-fields > section > dl { display: contents; }
.tqm-fields > section > h5 { grid-column: 1 / -1; }
/* Events keep a grid of their own — each is a card, indented under its head. */
.tqm-kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 6px 0; font-size: 11px; }
.tqm-kv.nested { margin: 2px 0 6px 12px; }
.tqm-kv dt,
.tqm-fields dt { color: var(--sw-fg-3); font-size: 10.5px; }
.tqm-kv dd,
.tqm-fields dd { margin: 0; color: var(--sw-fg-1); }
.tqm-kv dd.break,
.tqm-fields dd.break { overflow-wrap: anywhere; }
.tqm-kv dd.err,
.tqm-fields dd.err { color: var(--sw-err); }
h5 {
  margin: 12px 0 6px;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  /* Accent, as the native dialog's section heads are — they are the only
     landmarks in a long list of key/value rows. */
  color: var(--sw-accent);
  font-weight: 700;
}
.tqm-fields > section:first-child h5 { margin-top: 0; }
.tqm-events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.tqm-event-head { display: flex; gap: 10px; align-items: baseline; font-size: 11px; }
.dim { color: var(--sw-fg-3); font-size: 10px; margin-left: auto; }
.mono { font-family: var(--sw-mono); }
</style>
