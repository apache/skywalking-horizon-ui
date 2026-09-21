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
  OTLP span waterfall. The same shape as the native one — indented rows,
  service-coloured bars, a kind glyph, a duration suffix — over OTLP's own
  fields: span id and parent span id as opaque strings, `SPAN_KIND_*`, and a
  three-valued status.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import SpanKindGlyph from '@/components/primitives/SpanKindGlyph.vue';
import type { TraceQLSpan } from '@skywalking-horizon-ui/api-client';
import {
  buildServiceColors,
  buildSpanTree,
  fmtMs,
  kindColor,
  kindGlyphFamily,
  kindLabel,
  otlpKindName,
  serviceColorFrom,
  spanStatus,
  statusColor,
} from './traceqlDetailShared';

/** The selected SPAN OBJECT rather than its id: two Zipkin records can share a
 *  span id, and comparing ids highlights both. */
const props = defineProps<{ spans: TraceQLSpan[]; selectedSpan?: TraceQLSpan | null }>();
const emit = defineEmits<{ (e: 'select-span', span: TraceQLSpan): void }>();

const { t } = useI18n({ useScope: 'global' });
const rows = computed(() => buildSpanTree(props.spans));
const colors = computed(() => buildServiceColors(props.spans));
const total = computed(() => {
  const r = rows.value;
  if (r.length === 0) return 1;
  return Math.max(1, ...r.map((x) => x.offsetUs + x.span.durationUs));
});
const pct = (v: number): string => `${Math.min(100, (v / total.value) * 100)}%`;
</script>

<template>
  <ul class="tqw">
    <li
      v-for="row in rows"
      :key="row.key"
      class="tqw-row"
      :class="{ on: selectedSpan === row.span, err: spanStatus(row.span) === 'error' }"
      @click="emit('select-span', row.span)"
    >
      <span class="tqw-svc" :style="{ background: serviceColorFrom(colors, row.span.service) }" />
      <span class="tqw-status" :style="{ background: statusColor(spanStatus(row.span)) }" />
      <SpanKindGlyph
        class="tqw-kind"
        :family="kindGlyphFamily(row.span.kind)"
        :label="`${kindLabel(row.span.kind)} · ${otlpKindName(row.span.kind)}`"
        :style="{ color: kindColor(row.span.kind) }"
      />
      <!-- One band per row carries the span's place in time and its name, as
           the native waterfall does. -->
      <span class="tqw-band">
        <span
          class="tqw-band-bg"
          :style="{
            left: pct(row.offsetUs),
            width: pct(Math.max(row.span.durationUs, total / 400)),
            background: serviceColorFrom(colors, row.span.service),
            outlineColor: spanStatus(row.span) === 'error' ? 'var(--sw-err)' : 'transparent',
          }"
        />
        <span
          v-for="g in row.depth"
          :key="g"
          class="tqw-depth-guide"
          :style="{ left: `${(g - 1) * 22 + 10}px` }"
        />
        <span class="tqw-indent" :style="{ width: `${row.depth * 22}px` }" />
        <span class="tqw-name mono" :title="row.span.name || '—'">{{ row.span.name || '—' }}</span>
        <span
          v-if="row.span.scopeName"
          class="tqw-scope mono"
          :title="t('scope · {scope}', { scope: row.span.scopeName })"
        >→ {{ row.span.scopeName }}</span>
      </span>
      <span class="tqw-dur mono">{{ fmtMs(row.span.durationUs) }}</span>
    </li>
  </ul>
</template>

<style scoped>
.tqw { list-style: none; margin: 0; padding: 0; }
.tqw-row {
  display: flex;
  align-items: center;
  gap: 8px;
  /* The native waterfall's row metrics — same padding, same 11px, so the two
     trace details read at one size rather than two. */
  padding: 2px 8px 2px 0;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
  font-size: 11px;
  min-height: 28px;
}
.tqw-row:hover { background: var(--sw-bg-2); }
.tqw-row.on { background: var(--sw-bg-3); }
.tqw-row.err .tqw-name { color: var(--sw-err); }
.tqw-svc { width: 3px; height: 16px; border-radius: 1px; flex: 0 0 auto; }
.tqw-status { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; }
.tqw-kind { flex: 0 0 auto; }
/* The band: the bar behind, the name in front, the depth guides between —
   the native waterfall's row, over OTLP fields. */
.tqw-band {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 6px;
}
.tqw-band-bg {
  position: absolute;
  top: 4px;
  bottom: 4px;
  border-radius: 3px;
  opacity: 0.22;
  outline: 1px solid transparent;
}
.tqw-depth-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--sw-line-2);
  opacity: 0.5;
}
.tqw-indent { flex: 0 0 auto; }
.tqw-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--sw-fg-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  position: relative;
  z-index: 1;
  min-width: 0;
  flex: 0 1 auto;
}
.tqw-scope {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  position: relative;
  z-index: 1;
  min-width: 0;
  flex: 0 1 auto;
}
.tqw-dur { font-size: 10.5px; font-weight: 600; color: var(--sw-fg-2); flex: 0 0 auto; padding-right: 4px; }
.mono { font-family: var(--sw-mono); }
</style>
