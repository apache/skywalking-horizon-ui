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
  Run one MQE expression from the template editor and show what OAP returns.
  The editor fires no metric queries of its own, so without this the only way
  to find out whether an expression works is to push the template and go look.

  An MQE means nothing without an entity and a duration, so the panel supplies
  both. The LAYER is fixed — it is the template being edited. Nothing here is
  saved: this is a read, and the expression under test is whatever is in the
  field right now, including one that exists only in an unsaved draft.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { MqeExecResponse } from '@skywalking-horizon-ui/api-client';
import Modal from '@/components/primitives/Modal.vue';
import Btn from '@/components/primitives/Btn.vue';
import { bffClient } from '@/api/client';
import MqeEntityPicker, { type EntityShape, type PickedEntity } from './MqeEntityPicker.vue';
import MqeRangePicker from './MqeRangePicker.vue';
import MqeResultView from './MqeResultView.vue';
import { buildMqeEntity, isRelationScope, type MqeSiteScope } from './mqeEntity';

const props = defineProps<{
  open: boolean;
  /** The expression under test. Empty is legal — see `metric`. */
  expression: string;
  /** Column id used to resolve a blank expression to its catalog default. */
  metric?: string;
  /** Fixed: the template being edited. */
  layerKey: string;
  /** What this field's MQE is evaluated against. */
  siteScope: MqeSiteScope;
  /** Names the field in the panel header (e.g. "Service list column"). */
  title?: string;
}>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n({ useScope: 'global' });

const isRelation = computed(() => isRelationScope(props.siteScope));

/** The entity halves each site needs filled. A relation asks for the same
 *  shape on both sides. */
const shape = computed<EntityShape>(() => {
  switch (props.siteScope) {
    case 'instance':
    case 'instance-relation':
    case 'deployment-relation':
      return 'instance';
    case 'endpoint':
    case 'endpoint-relation':
      return 'endpoint';
    case 'process-relation':
      return 'process';
    default:
      return 'service';
  }
});

const source = ref<PickedEntity | null>(null);
const dest = ref<PickedEntity | null>(null);

/** The deployment graph never crosses services, so its destination picker
 *  inherits the source's service and chooses only an instance. Declared
 *  BELOW `source` — a ref read from a computed above its own declaration is
 *  a TDZ throw waiting for the first eager consumer. */
const destLockedService = computed(() =>
  props.siteScope === 'deployment-relation' ? (source.value?.serviceName ?? '') : '',
);
const rangeRef = ref<{ resolve: () => { step: 'MINUTE' | 'HOUR' | 'DAY'; startMs: number; endMs: number } } | null>(null);

const running = ref(false);
const response = ref<MqeExecResponse | null>(null);
const failure = ref<string | null>(null);
let inflight: AbortController | null = null;

/** A blank field is runnable ONLY where a metric id can resolve the catalog
 *  default — the service-list columns. Every other site's expression is the
 *  whole query, so an empty one has nothing to send. */
const runnableBlank = computed(() => !!props.metric);
const hasExpression = computed(() => !!props.expression.trim() || runnableBlank.value);
const canRun = computed(
  () => hasExpression.value && !!source.value && (!isRelation.value || !!dest.value),
);

/** The BFF names a reason (`missing_expression`, `invalid_range`, the OAP
 *  message); the thrown Error only carries the status line. Prefer the body,
 *  and fall back to the status when there is nothing better to say. */
function reasonOf(err: unknown): string {
  const body = (err as { body?: unknown } | null)?.body;
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; detail?: unknown };
    const detail = typeof b.detail === 'string' ? b.detail : '';
    const code = typeof b.error === 'string' ? b.error : '';
    if (detail) return code ? `${code}: ${detail}` : detail;
    if (code) return code;
  }
  return err instanceof Error ? err.message : String(err);
}

async function run(): Promise<void> {
  if (!canRun.value || running.value) return;
  // Cascade-clear: the previous answer must not sit under the spinner while a
  // different entity or window is in flight — it reads as the new result.
  inflight?.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  response.value = null;
  failure.value = null;
  running.value = true;
  const w = rangeRef.value?.resolve();
  try {
    const expr = props.expression.trim();
    response.value = await bffClient.mqe.exec(
      {
        ...(expr ? { expression: expr } : { metric: props.metric ?? '' }),
        layer: props.layerKey,
        entity: buildMqeEntity(props.siteScope, source.value!, dest.value),
        step: w?.step ?? 'MINUTE',
        startMs: w?.startMs ?? Date.now() - 3600_000,
        endMs: w?.endMs ?? Date.now(),
      },
      ctrl.signal,
    );
  } catch (err) {
    if (ctrl.signal.aborted) return;
    failure.value = reasonOf(err);
  } finally {
    if (inflight === ctrl) {
      inflight = null;
      running.value = false;
    }
  }
}

/**
 * Cascade-clear: an answer belongs to the entity and window that produced it,
 * so changing either must drop it rather than leave it sitting under controls
 * that now describe a different query. An operator reads a stale number as the
 * new one — that is the failure this exists to prevent, not a tidiness rule.
 */
function invalidate(): void {
  inflight?.abort();
  inflight = null;
  running.value = false;
  response.value = null;
  failure.value = null;
}
/** Compared by VALUE, not identity: the pickers re-emit a fresh object
 *  whenever their roster query settles, so watching the refs themselves would
 *  discard a perfectly good result on a background refetch that changed
 *  nothing the operator can see. */
const entityKey = computed(() => {
  const part = (e: PickedEntity | null) =>
    e
      ? `${e.serviceName}|${e.normal}|${e.instanceName ?? ''}|${e.endpointName ?? ''}|${e.processName ?? ''}`
      : '';
  return `${part(source.value)}»${part(dest.value)}`;
});
watch(entityKey, invalidate);

// A reopen must not show the previous field's answer.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      response.value = null;
      failure.value = null;
    } else {
      inflight?.abort();
      inflight = null;
      running.value = false;
    }
  },
);
onBeforeUnmount(() => inflight?.abort());

</script>

<template>
  <Modal
    :open="open"
    :title="title ? t('Run MQE · {field}', { field: title }) : t('Run MQE')"
    width="min(980px, 94vw)"
    fit-body
    @close="emit('close')"
  >
    <div class="mrp-body">
      <div class="mrp-expr">
        <span class="mrp-cap">{{ t('expression') }}</span>
        <code class="mrp-code" :class="{ 'is-empty': !expression.trim() }">{{
          expression.trim()
            || (runnableBlank
              ? t('(blank — the catalog default for this metric will run)')
              : t('(empty — type an expression to run it)'))
        }}</code>
      </div>

      <div class="mrp-controls">
        <div class="mrp-layer">
          <span class="mrp-cap">{{ t('layer') }}</span>
          <span class="mrp-fixed" :title="t('Fixed by the template being edited')">{{ layerKey || '—' }}</span>
        </div>
        <MqeRangePicker ref="rangeRef" @change="invalidate" />
      </div>

      <MqeEntityPicker
        :layer-key="layerKey"
        :shape="shape"
        :allow-layer-wide="!isRelation"
        :legend="isRelation ? t('source') : undefined"
        @pick="source = $event"
      />
      <MqeEntityPicker
        v-if="isRelation"
        :layer-key="layerKey"
        :shape="shape"
        :legend="t('destination')"
        :locked-service="destLockedService"
        @pick="dest = $event"
      />

      <p v-if="isRelation" class="mrp-hint">
        {{ t('Relation metrics are queried without an explicit scope — OAP reads it from the metric name.') }}
      </p>

      <div class="mrp-actions">
        <Btn kind="primary" size="sm" :disabled="!canRun || running" @click="run">
          {{ running ? t('Running…') : t('Run') }}
        </Btn>
        <span v-if="response" class="mrp-meta">
          {{ response.result.type }} ·
          {{ response.window.start }} → {{ response.window.end }} ({{ response.window.step }})
          <template v-if="response.coldStage"> · {{ t('cold stage') }}</template>
        </span>
      </div>

      <p v-if="response?.resolvedFromCatalog" class="mrp-hint">
        {{ t('Blank field — ran the catalog default: {expr}', { expr: response.expression }) }}
      </p>

      <div class="mrp-result">
        <p v-if="running" class="mrp-hint">{{ t('Reading data…') }}</p>
        <p v-else-if="failure" class="mrp-fail">{{ failure }}</p>
        <MqeResultView
          v-else-if="response"
          :result="response.result"
          :step="response.window.step"
        />
        <p v-else class="mrp-hint">{{ t('Pick an entity and run to see what OAP returns.') }}</p>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.mrp-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  flex: 1;
}
.mrp-cap {
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
}
.mrp-expr { display: flex; flex-direction: column; gap: 3px; }
.mrp-code {
  font-family: var(--sw-mono);
  font-size: 12px;
  color: var(--sw-fg-0);
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 6px 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.mrp-controls { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.mrp-layer { display: flex; flex-direction: column; gap: 3px; }
.mrp-fixed {
  font-family: var(--sw-mono);
  font-size: 12px;
  color: var(--sw-fg-1);
  background: var(--sw-bg-3);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 4px 10px;
}
.mrp-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.mrp-meta {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-3);
}
.mrp-hint { margin: 0; font-size: 11.5px; color: var(--sw-fg-3); }
.mrp-fail {
  margin: 0;
  font-size: 12px;
  color: var(--sw-err);
  font-family: var(--sw-mono);
  word-break: break-word;
}
/* `hidden`, not `auto`: each result view scrolls INSIDE its own frame — the
   value tables in their scroll box, Monaco in its editor. Letting this
   container scroll instead makes every child height-unbounded, so a long
   document grows past the modal and drags the actions below it out of
   reach. */
.mrp-result { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
</style>
