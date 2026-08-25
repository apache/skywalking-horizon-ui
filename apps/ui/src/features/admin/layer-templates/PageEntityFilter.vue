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
  Authoring the entity set an extension page is about.

  This is the ONLY place the filter is visible. The rendered page shows
  the filtered list and says nothing — an operator reading it did not
  write the filter and is not owed its syntax. Which makes the assistance
  below load-bearing rather than decorative: it is the one chance to see
  what a filter selects before it reaches anyone, and the only way to
  catch an attribute key that matches nothing because it was mistyped.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  MAX_INSTANCE_ATTRIBUTE_PREDICATES,
  type InstanceAttributePredicate,
} from '@skywalking-horizon-ui/api-client';
import { isRegexFilter, serviceFilterMatcher } from '@/layer/serviceFilter';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useLayerEndpoints } from '@/layer/useLayerEndpoints';
import { instancePageMatcher } from '@/render/layer-dashboard/instancePageFilter';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';
import Modal from '@/features/operate/_shared/Modal.vue';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  /** Which pickers this page's screen shows. `endpoint` narrows the
   *  service list like `service` does, and browses endpoints beneath it —
   *  there is no endpoint filter, so that half is informational. */
  mode: 'service' | 'instance' | 'endpoint';
  layerKey: string;
  /** What this page calls the entity it lists. `undefined` hides the row
   *  — the DEFAULT page is named by the layer's own Menu labels. */
  alias?: string;
  showAlias?: boolean;
  /** Every entity page narrows the service picker — an Instance page
   *  shows it too, because a service is picked before an instance. */
  serviceFilter: string;
  /** Instance pages only, applied within the service picked above. */
  instanceFilter?: string;
  attributes?: InstanceAttributePredicate[];
  /** The layer's own roster, for the assistance list. Rows, not names:
   *  the instance preview needs the service ID — the BFF refuses a name
   *  that arrives without one, deliberately, so a name can never be
   *  mistaken for another service's id. Empty while it loads, which
   *  shows an unavailable state rather than blocking the edit. */
  services: readonly { id: string; name: string }[];
  readOnly?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:alias', v: string): void;
  (e: 'update:serviceFilter', v: string): void;
  (e: 'update:instanceFilter', v: string): void;
  (e: 'update:attributes', v: InstanceAttributePredicate[]): void;
}>();

/** One row's worth of state, so the Service and Instance fields are the
 *  same control rather than two near-copies. */
function fieldFor(get: () => string, set: (v: string) => void) {
  const isRegex = computed(() => isRegexFilter(get().trim()));
  const body = computed(() => (isRegex.value ? get().trim().slice(1, -1) : get()));
  return {
    isRegex,
    body,
    invalid: computed(() => get().trim().length > 0 && serviceFilterMatcher(get()).invalid),
    setText: (v: string) => set(isRegex.value && v.trim() !== '' ? `/${v}/` : v),
    setRegex: (on: boolean) => {
      const b = body.value.trim();
      set(b === '' ? '' : on ? `/${b}/` : b);
    },
  };
}
const svc = fieldFor(() => props.serviceFilter, (v) => emit('update:serviceFilter', v));
const inst = fieldFor(() => props.instanceFilter ?? '', (v) => emit('update:instanceFilter', v));


/* ── Attribute conditions (Instance pages) ───────────────────────── */
const attrs = computed<InstanceAttributePredicate[]>(() => props.attributes ?? []);
const writeAttrs = (next: InstanceAttributePredicate[]): void => emit('update:attributes', next);
const atAttrCap = computed(() => attrs.value.length >= MAX_INSTANCE_ATTRIBUTE_PREDICATES);
function addAttr(): void {
  // Publish refuses a ninth, so the editor must not mint one.
  if (atAttrCap.value) return;
  writeAttrs([...attrs.value, { attribute: '', op: 'exists' }]);
}
function removeAttr(i: number): void {
  writeAttrs(attrs.value.filter((_, j) => j !== i));
}
function patchAttr(i: number, patch: Partial<InstanceAttributePredicate>): void {
  writeAttrs(
    attrs.value.map((a, j) => {
      if (j !== i) return a;
      const next = { ...a, ...patch };
      // `exists` carries no value; leaving one behind would publish a
      // field the evaluator ignores and the diff keeps showing.
      if (next.op === 'exists') delete next.value;
      return next;
    }),
  );
}

/* ── Assistance: what is available, and what this selects ──────────
 *
 * Instances only exist under a service, which the layer editor has not
 * picked — so the operator picks one to preview against. It is a sample,
 * not the answer for every service, and the wording says so. */
const previewOpen = ref(false);
const previewService = ref<string>('');
/** The sample-service dropdown offers only what the page's service
 *  filter allows — previewing instances under a service the page hides
 *  would answer a question nobody asked. */
const inScopeServices = computed(() => {
  const m = serviceFilterMatcher(props.serviceFilter);
  return props.services.filter((x) => m.match(x.name));
});
const serviceOptions = computed(() => inScopeServices.value.map((x) => ({ value: x.id, label: x.name })));
// Sourced on `inScopeServices`, not `props.services`: the roster keeps its
// identity while the filter changes, so the pick would never revalidate.
// Must stay BELOW it — `immediate: true` runs during setup, where a later
// `const` is still in the TDZ and throws with no rendered error.
watch(
  inScopeServices,
  (rows) => {
    if (rows.length === 0) return;
    // Keep the pick only while the filter still allows it.
    if (!rows.some((x) => x.id === previewService.value)) previewService.value = rows[0]!.id;
  },
  { immediate: true },
);
const serviceCount = computed(() =>
  props.services.length === 0
    ? null
    : t('{n} of {total}', { n: inScopeServices.value.length, total: props.services.length }),
);
const instanceService = computed(() => {
  if (props.mode === 'service') return null;
  const row = inScopeServices.value.find((x) => x.id === previewService.value);
  return row ? { id: row.id, name: row.name } : null;
});
const { instances, isFetching: instancesLoading } = useLayerInstances(
  computed(() => (props.mode === 'instance' ? props.layerKey : '')),
  instanceService,
);
/** Endpoints of the sampled service. There is no endpoint filter to
 *  preview — this answers the other half of the question an endpoint
 *  page raises: what is actually under the services it selects. The
 *  search is the ROUTE's own keyword query, as the runtime picker uses. */
const endpointQuery = ref('');
const { endpoints, isFetching: endpointsLoading } = useLayerEndpoints(
  computed(() => (props.mode === 'endpoint' ? props.layerKey : '')),
  computed(() => (props.mode === 'endpoint' ? instanceService.value : null)),
  endpointQuery,
  ref(50),
);

/** Every service, with the ones this page's service filter selects lit. */
const serviceRows = computed<Array<{ name: string; hit: boolean }>>(() => {
  const m = serviceFilterMatcher(props.serviceFilter);
  return props.services.map((x) => ({ name: x.name, hit: m.match(x.name) }));
});
/** Every instance of the sampled service, with this page's set lit. */
const instanceRows = computed<Array<{ name: string; hit: boolean }>>(() => {
  const m = instancePageMatcher({
    instanceFilter: props.instanceFilter,
    instanceAttributes: attrs.value,
  });
  return instances.value.map((i) => ({ name: i.name, hit: m(i) }));
});
/** What the page will actually show — services on a Service page, and
 *  the entity beneath the service on the other two. */
const rows = computed(() => (props.mode === 'instance' ? instanceRows.value : serviceRows.value));
/** Defaults to every candidate: what a filter EXCLUDES is what makes it
 *  checkable — a list of only the hits looks right either way. */
const showAll = ref(true);
const shown = (list: Array<{ name: string; hit: boolean }>): Array<{ name: string; hit: boolean }> =>
  showAll.value ? list : list.filter((r) => r.hit);

/* ── Paging. A roster runs to hundreds; the popout shows a screenful and
 *    pages through the rest rather than scrolling a wall of names. ── */
const PER_PAGE = 20;
const svcPage = ref(1);
const instPage = ref(1);
const epPage = ref(1);
const pageCount = (n: number): number => Math.max(1, Math.ceil(n / PER_PAGE));
/** Clamped rather than reset: the list shrinks under the operator when
 *  they switch to Filtered, and a page number past the end shows blank. */
const clamp = (page: number, total: number): number => Math.min(Math.max(1, page), pageCount(total));
const slice = <T,>(list: T[], page: number): T[] => list.slice((page - 1) * PER_PAGE, page * PER_PAGE);
const rangeLabel = (page: number, total: number): string =>
  t('{from}–{to} of {total}', { from: (page - 1) * PER_PAGE + 1, to: Math.min(page * PER_PAGE, total), total });

const svcShown = computed(() => shown(serviceRows.value));
const svcPageNo = computed(() => clamp(svcPage.value, svcShown.value.length));
const svcSlice = computed(() => slice(svcShown.value, svcPageNo.value));
const instShown = computed(() => shown(instanceRows.value));
const instPageNo = computed(() => clamp(instPage.value, instShown.value.length));
const instSlice = computed(() => slice(instShown.value, instPageNo.value));
const epPageNo = computed(() => clamp(epPage.value, endpoints.value.length));
const epSlice = computed(() => slice(endpoints.value, epPageNo.value));
// Back to the first page when the SET changes under them — a filter edit
// or a different sample service is a new list, not page 4 of the old one.
watch([showAll, () => props.serviceFilter, () => props.instanceFilter, previewService, endpointQuery], () => {
  svcPage.value = 1;
  instPage.value = 1;
  epPage.value = 1;
});
const hitCount = computed(() => rows.value.filter((r) => r.hit).length);
const unavailable = computed(() => rows.value.length === 0);
</script>

<template>
  <!-- One grid, so every row's label, field and switch line up: the rows
       ask different questions but they are the same shape, and a ragged
       column reads as three unrelated controls. -->
  <div class="pef">
    <label v-if="showAlias" class="pef-row">
      <span class="pef-label">{{ t('Entity label') }}</span>
      <div class="pef-field">
        <input
          class="pef-input pef-alias"
          type="text"
          :value="alias ?? ''"
          :placeholder="readOnly ? '' : t('what this page calls them')"
          :disabled="readOnly"
          spellcheck="false"
          @input="emit('update:alias', ($event.target as HTMLInputElement).value)"
        />
        <span class="pef-hint">{{ t('Blank uses the layer’s own menu label.') }}</span>
      </div>
    </label>

    <label class="pef-row">
      <span class="pef-label">{{ t('Service filter') }}</span>
      <div class="pef-field">
        <input
          class="pef-input pef-service-filter"
          :class="{ invalid: svc.invalid.value }"
          type="text"
          :value="svc.body.value"
          :placeholder="readOnly ? '' : svc.isRegex.value ? t('regular expression') : t('name fragment')"
          :disabled="readOnly"
          spellcheck="false"
          @input="svc.setText(($event.target as HTMLInputElement).value)"
        />
        <label class="pef-regex" :class="{ on: svc.isRegex.value }">
          <input type="checkbox" :checked="svc.isRegex.value" :disabled="readOnly" @change="svc.setRegex(($event.target as HTMLInputElement).checked)" />
          {{ t('regex') }}
        </label>
        <span v-if="svc.invalid.value" class="page-issue">{{ t('Not a valid regular expression.') }}</span>
        <span v-else-if="serviceCount" class="pef-count">{{ serviceCount }}</span>
        <!-- Its own preview on the pages where the bottom one is about
             something else: on an Instance or Endpoint page the service
             filter is otherwise checkable only by a count. -->
        <button v-if="mode !== 'service'" type="button" class="sw-btn xs" @click="previewOpen = true">
          {{ t('Preview') }}
        </button>
      </div>
    </label>

    <!-- The instance half, applied within the service picked above. -->
    <template v-if="mode === 'instance'">
      <label class="pef-row">
        <span class="pef-label">{{ t('Instance filter') }}</span>
        <div class="pef-field">
          <input
            class="pef-input pef-instance-filter"
            :class="{ invalid: inst.invalid.value }"
            type="text"
            :value="inst.body.value"
            :placeholder="readOnly ? '' : inst.isRegex.value ? t('regular expression') : t('name fragment')"
            :disabled="readOnly"
            spellcheck="false"
            @input="inst.setText(($event.target as HTMLInputElement).value)"
          />
          <label class="pef-regex" :class="{ on: inst.isRegex.value }">
            <input type="checkbox" :checked="inst.isRegex.value" :disabled="readOnly" @change="inst.setRegex(($event.target as HTMLInputElement).checked)" />
            {{ t('regex') }}
          </label>
          <span v-if="inst.invalid.value" class="page-issue">{{ t('Not a valid regular expression.') }}</span>
        </div>
      </label>

      <div class="pef-row">
        <span class="pef-label">{{ t('Attribute conditions') }}</span>
        <div class="pef-attrs">
          <p v-if="attrs.length === 0" class="pef-hint">{{ t('No conditions — every instance matching the name filter is shown.') }}</p>
          <!-- Fixed columns so the operator reads down a column rather
               than re-finding each field on every row. -->
          <div v-for="(a, i) in attrs" :key="i" class="pef-attr">
            <input
              class="pef-input"
              type="text"
              :value="a.attribute"
              :placeholder="t('attribute, e.g. namespace')"
              :disabled="readOnly"
              spellcheck="false"
              @input="patchAttr(i, { attribute: ($event.target as HTMLInputElement).value })"
            />
            <TypeaheadSelect
              :model-value="a.op"
              :options="[{ value: 'exists', label: t('exists') }, { value: 'eq', label: t('equals') }]"
              :disabled="readOnly"
              :min-panel-width="140"
              @update:model-value="(v) => patchAttr(i, { op: v as 'exists' | 'eq' })"
            />
            <input
              v-if="a.op === 'eq'"
              class="pef-input"
              type="text"
              :value="a.value ?? ''"
              :placeholder="t('value')"
              :disabled="readOnly"
              spellcheck="false"
              @input="patchAttr(i, { value: ($event.target as HTMLInputElement).value })"
            />
            <span v-else class="pef-input-gap" />
            <button v-if="!readOnly" type="button" class="sw-btn xs danger" @click="removeAttr(i)">{{ t('Remove') }}</button>
          </div>
          <button
            v-if="!readOnly && !atAttrCap"
            type="button"
            class="sw-btn xs pef-add"
            @click="addAttr"
          >{{ t('＋ Condition') }}</button>
          <p v-else-if="!readOnly" class="pef-hint">
            {{ t('{n} conditions is the maximum for one page.', { n: MAX_INSTANCE_ATTRIBUTE_PREDICATES }) }}
          </p>
        </div>
      </div>
    </template>

    <div class="pef-row">
      <span class="pef-label">{{ t('Matches') }}</span>
      <div class="pef-check">
        <button type="button" class="sw-btn xs" @click="previewOpen = true">
          {{ t('Preview matches') }}
        </button>
        <span v-if="!unavailable" class="pef-count">
          {{ t('{n} of {total}', { n: hitCount, total: rows.length }) }}
        </span>
        <!-- The one failure invisible on the rendered page stays on the
             surface rather than behind the button. -->
        <span v-if="!unavailable && hitCount === 0" class="page-issue">
          {{ t('Nothing matches — this page would show an empty list.') }}
        </span>
      </div>
    </div>

    <Modal
      :open="previewOpen"
      :title="mode === 'instance' ? t('Instances this page shows') : t('Services this page shows')"
      width="min(680px, 94vw)"
      @close="previewOpen = false"
    >
      <!-- One switch for both panes, so they cannot disagree. Endpoints
           have no filter, so nothing there is excluded to hide. -->
      <div class="pef-seg" role="group" :aria-label="t('Show')">
        <button type="button" :class="{ on: showAll }" @click="showAll = true">{{ t('All') }}</button>
        <button type="button" :class="{ on: !showAll }" @click="showAll = false">{{ t('Filtered') }}</button>
      </div>

      <!-- The service list first, because every entity page starts by
           picking a service — and on an Instance or Endpoint page it is
           the only preview the service filter has. -->
      <div class="pef-pane">
        <div class="pef-pane-head">
          <span class="pef-label">{{ t('Services') }}</span>
          <span v-if="props.services.length" class="pef-count">
            {{ t('{n} of {total}', { n: inScopeServices.length, total: props.services.length }) }}
          </span>
        </div>
        <p v-if="props.services.length === 0" class="pef-hint">{{ t('service list unavailable') }}</p>
        <ul v-else class="pef-list">
          <li v-for="r in svcSlice" :key="r.name" :class="{ hit: r.hit }">
            <span class="pef-dot" />{{ r.name }}
          </li>
        </ul>
        <div v-if="svcShown.length > 0" class="pef-pager">
          <button type="button" class="sw-btn xs ghost" :disabled="svcPageNo <= 1" @click="svcPage = svcPageNo - 1">‹</button>
          <span>{{ rangeLabel(svcPageNo, svcShown.length) }}</span>
          <button type="button" class="sw-btn xs ghost" :disabled="svcPageNo >= pageCount(svcShown.length)" @click="svcPage = svcPageNo + 1">›</button>
        </div>
        <p v-if="props.services.length > 0 && inScopeServices.length === 0" class="page-issue">
          {{ t('Nothing matches — this page would show an empty list.') }}
        </p>
      </div>

      <!-- Beneath a selected service: the entity the page is about. -->
      <div v-if="mode !== 'service'" class="pef-pane">
        <div class="pef-pane-head">
          <span class="pef-label">{{ mode === 'instance' ? t('Instances') : t('Endpoints') }}</span>
          <label class="pef-sample">
            <span>{{ t('under') }}</span>
            <TypeaheadSelect
              :model-value="previewService"
              :options="serviceOptions"
              :disabled="serviceOptions.length === 0"
              :min-panel-width="260"
              :aria-label="t('Sample service')"
              @update:model-value="(v) => (previewService = v as string)"
            />
          </label>
          <input
            v-if="mode === 'endpoint'"
            v-model="endpointQuery"
            class="pef-input pef-search"
            type="text"
            :placeholder="t('search endpoints…')"
            spellcheck="false"
          />
          <span v-if="mode === 'instance' && instances.length" class="pef-count">
            {{ t('{n} of {total}', { n: hitCount, total: instanceRows.length }) }}
          </span>
        </div>
        <p v-if="instancesLoading || endpointsLoading" class="pef-hint">{{ t('Reading data…') }}</p>
        <template v-else-if="mode === 'instance'">
          <p v-if="instanceRows.length === 0" class="pef-hint">{{ t('No instances to preview against.') }}</p>
          <ul v-else class="pef-list">
            <li v-for="r in instSlice" :key="r.name" :class="{ hit: r.hit }">
              <span class="pef-dot" />{{ r.name }}
            </li>
          </ul>
          <div v-if="instShown.length > 0" class="pef-pager">
            <button type="button" class="sw-btn xs ghost" :disabled="instPageNo <= 1" @click="instPage = instPageNo - 1">‹</button>
            <span>{{ rangeLabel(instPageNo, instShown.length) }}</span>
            <button type="button" class="sw-btn xs ghost" :disabled="instPageNo >= pageCount(instShown.length)" @click="instPage = instPageNo + 1">›</button>
          </div>
          <p v-if="instanceRows.length > 0 && hitCount === 0" class="page-issue">
            {{ t('Nothing matches — this page would show an empty list.') }}
          </p>
        </template>
        <template v-else>
          <!-- Endpoints are browsed, not matched: an Endpoint page has no
               endpoint filter, so this answers "what is under the
               services this page selects" rather than "what is lit". -->
          <p v-if="endpoints.length === 0" class="pef-hint">{{ t('No endpoints found.') }}</p>
          <ul v-else class="pef-list">
            <li v-for="e in epSlice" :key="e.id" class="hit">
              <span class="pef-dot" />{{ e.name }}
            </li>
          </ul>
          <div v-if="endpoints.length > 0" class="pef-pager">
            <button type="button" class="sw-btn xs ghost" :disabled="epPageNo <= 1" @click="epPage = epPageNo - 1">‹</button>
            <span>{{ rangeLabel(epPageNo, endpoints.length) }}</span>
            <button type="button" class="sw-btn xs ghost" :disabled="epPageNo >= pageCount(endpoints.length)" @click="epPage = epPageNo + 1">›</button>
          </div>
        </template>
      </div>

      <template #footer>
        <button class="sw-btn" type="button" @click="previewOpen = false">{{ t('Close') }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
/* A two-column grid: labels in a fixed left column so every field starts
   at the same x. The rows ask different questions and are different
   heights; without the column they read as unrelated controls. */
.pef { display: flex; flex-direction: column; gap: 10px; }
.pef-row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  align-items: start;
  gap: 4px 10px;
}
/* The switch, count and issue sit beside the field, not under it. */
/* One line: field, switch, then the count or the issue. */
.pef-field { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.pef-label {
  padding-top: 4px;
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--sw-fg-2);
}
.pef-input {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font-size: 12px;
  padding: 3px 7px;
  width: 100%;
  max-width: 320px;
  font-family: var(--sw-mono);
}
.pef-input.invalid { border-color: var(--sw-danger); }
.pef-input:disabled { opacity: 0.55; }
.pef-regex {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--sw-fg-2);
  cursor: pointer;
}
.pef-regex.on { color: var(--sw-accent); }
.pef-attrs { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
/* Fixed columns, so attribute / operator / value / Remove line up down
   the rows — an `exists` row keeps the value column as a gap rather than
   sliding its Remove button left. */
.pef-attr {
  display: grid;
  /* The trailing 1fr absorbs the slack, so Remove sits next to the value
     instead of stretching to the far edge of a wide card. */
  grid-template-columns: minmax(0, 220px) minmax(150px, auto) minmax(0, 200px) auto 1fr;
  align-items: center;
  gap: 6px;
}
.pef-attr .pef-input { max-width: none; }
/* Grid children default to min-width:auto, so the operator select refused
   to shrink and sat ON the value box beside it. */
.pef-attr > * { min-width: 0; }
.pef-input-gap { display: block; }
.pef-add { justify-self: start; }
.pef-hint { margin: 0; font-size: 11.5px; color: var(--sw-fg-3); }
.pef-check { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pef-count { font-size: 11px; color: var(--sw-fg-2); }
.pef-pane + .pef-pane { margin-top: 16px; border-top: 1px solid var(--sw-line-2); padding-top: 14px; }
.pef-pane-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.pef-search { max-width: 220px; }
.pef-sample { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--sw-fg-3); }
.pef-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--sw-line-3);
  border-radius: 4px;
}
.pef-list li {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 9px;
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-3);
}
.pef-list li + li { border-top: 1px solid var(--sw-line-3); }
.pef-pager {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--sw-fg-3);
}
.pef-seg {
  display: inline-flex;
  margin-bottom: 12px;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  overflow: hidden;
}
.pef-seg button {
  padding: 3px 12px;
  font-size: 11px;
  background: transparent;
  color: var(--sw-fg-3);
  border: 0;
  cursor: pointer;
}
.pef-seg button.on { background: var(--sw-bg-3); color: var(--sw-fg-0); }
.pef-seg button + button { border-left: 1px solid var(--sw-line-2); }
.pef-list li.hit { color: var(--sw-fg-0); }
.pef-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--sw-line-2);
}
.pef-list li.hit .pef-dot { background: var(--sw-accent); }
</style>
