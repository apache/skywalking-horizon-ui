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
  Events detail panel. Shows the single event picked on the swimlane — its
  name/type, the service + instance it was reported for, the layer, the time
  (a span when it has an end, otherwise the instant), the message, and the
  reporter parameters. OAP-supplied strings (service, instance, message,
  parameter values) render verbatim.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { EventRow } from '@/api/client';
import { eventTs } from './ganttLayout';

const { t } = useI18n();
const props = defineProps<{ event: EventRow | null }>();

function fmtFull(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}
/** The reporter's start (falling back to the event timestamp when the start
 *  event was lost) and the end, or null for an instantaneous event. */
const startMs = computed<number>(() => {
  const e = props.event;
  if (!e) return 0;
  return e.startTime && e.startTime > 0 ? e.startTime : eventTs(e);
});
const endMs = computed<number | null>(() => {
  const e = props.event;
  if (!e || !e.endTime || e.endTime <= startMs.value) return null;
  return e.endTime;
});
</script>

<template>
  <aside class="evt-detail">
    <div v-if="!event" class="evt-detail__empty">
      {{ t('Select an event to inspect its details and instances.') }}
    </div>
    <template v-else>
      <header class="evt-detail__head">
        <span class="sw-badge" :class="event.type === 'Error' ? 'is-err' : 'is-info'">
          <span class="state-dot" />{{ event.type }}
        </span>
        <h3 class="evt-detail__name">{{ event.name }}</h3>
      </header>

      <dl class="evt-detail__meta">
        <div><dt>{{ t('Service') }}</dt><dd><code>{{ event.source.service }}</code></dd></div>
        <div>
          <dt>{{ t('Instance') }}</dt>
          <dd><code>{{ event.source.serviceInstance || t('(service-scoped)') }}</code></dd>
        </div>
        <div v-if="event.source.endpoint">
          <dt>{{ t('Endpoint') }}</dt><dd><code>{{ event.source.endpoint }}</code></dd>
        </div>
        <div><dt>{{ t('Layer') }}</dt><dd>{{ event.layer }}</dd></div>
        <template v-if="endMs !== null">
          <div><dt>{{ t('Started') }}</dt><dd class="mono">{{ fmtFull(startMs) }}</dd></div>
          <div><dt>{{ t('Ended') }}</dt><dd class="mono">{{ fmtFull(endMs) }}</dd></div>
          <div><dt>{{ t('Duration') }}</dt><dd class="mono">{{ fmtDuration(endMs - startMs) }}</dd></div>
        </template>
        <div v-else><dt>{{ t('Time') }}</dt><dd class="mono">{{ fmtFull(startMs) }}</dd></div>
      </dl>

      <div v-if="event.message" class="evt-detail__msg">{{ event.message }}</div>

      <section v-if="event.parameters.length > 0" class="evt-detail__section">
        <h4>{{ t('Parameters') }}</h4>
        <dl class="evt-detail__params">
          <div v-for="(p, i) in event.parameters" :key="i">
            <dt>{{ p.key }}</dt>
            <dd><code>{{ p.value }}</code></dd>
          </div>
        </dl>
      </section>
    </template>
  </aside>
</template>

<style scoped>
.evt-detail {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  padding: 14px;
  align-self: start;
  position: sticky;
  top: 16px;
}
.evt-detail__empty { padding: 24px 8px; text-align: center; font-size: 12px; color: var(--sw-fg-3); }
.evt-detail__head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.evt-detail__name {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--sw-fg-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.evt-detail__meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0 0 12px; font-size: 11.5px; }
.evt-detail__meta > div { display: contents; }
.evt-detail__meta dt { color: var(--sw-fg-3); text-transform: uppercase; font-size: 9.5px; letter-spacing: 0.06em; align-self: center; }
.evt-detail__meta dd { margin: 0; color: var(--sw-fg-1); overflow: hidden; text-overflow: ellipsis; }
.evt-detail__meta code { font-family: var(--sw-mono); font-size: 11px; color: var(--sw-fg-0); }
.evt-detail__msg {
  font-size: 12px;
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  padding: 8px 10px;
  margin-bottom: 12px;
  word-break: break-word;
}
.evt-detail__section { margin-top: 12px; }
.evt-detail__section h4 {
  margin: 0 0 6px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
}
.evt-detail__params { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; font-size: 11.5px; }
.evt-detail__params > div { display: contents; }
.evt-detail__params dt { color: var(--sw-fg-2); font-family: var(--sw-mono); font-size: 10.5px; }
.evt-detail__params dd { margin: 0; min-width: 0; }
.evt-detail__params code { font-family: var(--sw-mono); font-size: 10.5px; color: var(--sw-fg-1); word-break: break-all; }

.sw-badge {
  display: inline-flex;
  align-items: center;
  font-size: 10.5px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid transparent;
}
.sw-badge .state-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-right: 4px; display: inline-block; vertical-align: middle; }
.sw-badge.is-err { color: var(--sw-err); background: var(--sw-err-soft); border-color: rgba(239,68,68,0.3); }
.sw-badge.is-info { color: var(--sw-accent-2); background: var(--sw-accent-soft); border-color: var(--sw-accent-line); }
</style>
