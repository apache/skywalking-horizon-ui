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
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  isCatalog,
  type BundledEntry,
  type BundledRow,
  type Catalog,
  type ListEnvelope,
  type ListRow,
} from '@skywalking-horizon-ui/api-client';
import { bff } from '@/api/client';
import { groupRules } from '@/features/operate/_shared/grouping';
import RuleCard from '@/features/operate/_shared/RuleCard.vue';
import Pill from '@/components/primitives/Pill.vue';
import Btn from '@/components/primitives/Btn.vue';
import AdminFeatureWarning from '@/shell/AdminFeatureWarning.vue';

const route = useRoute();
const router = useRouter();

const catalog = computed<Catalog | null>(() => {
  const raw = route.params.catalog;
  return typeof raw === 'string' && isCatalog(raw) ? raw : null;
});

/** OAP splits the world: `/runtime/rule/list` covers rows the
 *  `dslManager` knows about (operator-pushed runtime rules + any
 *  bundled rules the runtime has touched); `/runtime/rule/bundled`
 *  covers every static-on-disk rule shipped with OAP. The catalog
 *  browser merges them so the operator sees every manageable rule
 *  without having to push something first. */
const listQuery = useQuery({
  queryKey: computed(() => ['catalog/list', catalog.value]),
  queryFn: async (): Promise<ListEnvelope | null> => {
    if (!catalog.value) return null;
    return bff.dsl.catalogList(catalog.value);
  },
  enabled: computed(() => catalog.value !== null),
});

const bundledQuery = useQuery({
  queryKey: computed(() => ['catalog/bundled', catalog.value]),
  queryFn: async (): Promise<BundledEntry[] | null> => {
    if (!catalog.value) return null;
    // withContent=false — we only need the names + hashes for the
    // catalog grid; the editor pulls full YAML on click.
    return bff.dsl.catalogBundled(catalog.value, false);
  },
  enabled: computed(() => catalog.value !== null),
});

/** Materialise a `/bundled` entry into the synthetic `BundledRow`
 *  shape Studio's catalog grid expects. No `loaderName` / no
 *  `localState` data on the wire — the dslManager hasn't seen this
 *  rule yet, so we fill the minimum surface RuleCard reads. */
function bundledRowFor(c: Catalog, e: BundledEntry): BundledRow {
  return {
    catalog: c,
    name: e.name,
    status: 'BUNDLED',
    localState: 'NOT_LOADED',
    loaderGc: 'LIVE',
    loaderKind: 'BUNDLED',
    loaderName: '',
    contentHash: e.contentHash,
    bundled: true,
    bundledContentHash: e.contentHash,
    pendingUnregister: false,
  };
}

/** Merge `/list` and `/bundled`. Runtime rows win on collision —
 *  `/bundled.overridden: true` rows are already represented by the
 *  matching ACTIVE/INACTIVE row from `/list`. */
const mergedRules = computed<ListRow[]>(() => {
  const c = catalog.value;
  if (!c) return [];
  const env = listQuery.data.value;
  const bundled = bundledQuery.data.value ?? [];
  const out: ListRow[] = env ? [...env.rules] : [];
  const seen = new Set(out.map((r) => r.name));
  for (const e of bundled) {
    if (e.overridden) continue;
    if (seen.has(e.name)) continue;
    out.push(bundledRowFor(c, e));
  }
  return out;
});

// ── Search + status filter (browser-side) ────────────────────────
//
// Names can grow to a few hundred per catalog; an inline filter strip
// is faster than scrolling. The match is substring-on-name (operator
// types `activemq`, gets every activemq/* rule); the status filter
// is multi-select-as-toggle for ACTIVE / INACTIVE / BUNDLED / orphan.

type StatusFilter = 'all' | 'active' | 'inactive' | 'bundled' | 'modified';
const statusFilter = ref<StatusFilter>('all');
const search = ref<string>('');

function matchesStatus(r: ListRow, f: StatusFilter): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'active':
      return r.status === 'ACTIVE';
    case 'inactive':
      return r.status === 'INACTIVE';
    case 'bundled':
      return r.status === 'BUNDLED';
    case 'modified':
      // Operator-pushed row whose content differs from the bundled twin.
      return (
        (r.status === 'ACTIVE' || r.status === 'INACTIVE') &&
        r.bundled === true &&
        r.bundledContentHash !== undefined &&
        r.bundledContentHash !== r.contentHash
      );
  }
}

const filteredRules = computed<ListRow[]>(() => {
  const term = search.value.trim().toLowerCase();
  return mergedRules.value.filter((r) => {
    if (!matchesStatus(r, statusFilter.value)) return false;
    if (term && !r.name.toLowerCase().includes(term)) return false;
    return true;
  });
});

const groups = computed(() => groupRules(filteredRules.value));

const ruleCount = computed(() => mergedRules.value.length);
const filteredCount = computed(() => filteredRules.value.length);
const bundledCount = computed(() =>
  mergedRules.value.reduce((n, r) => n + (r.status === 'BUNDLED' ? 1 : 0), 0),
);

interface StatusFacet { id: StatusFilter; label: string; count: number; }
const statusFacets = computed<StatusFacet[]>(() => {
  const counts: Record<StatusFilter, number> = {
    all: mergedRules.value.length,
    active: 0,
    inactive: 0,
    bundled: 0,
    modified: 0,
  };
  for (const r of mergedRules.value) {
    if (r.status === 'ACTIVE') counts.active += 1;
    else if (r.status === 'INACTIVE') counts.inactive += 1;
    else if (r.status === 'BUNDLED') counts.bundled += 1;
    if (matchesStatus(r, 'modified')) counts.modified += 1;
  }
  return [
    { id: 'all', label: 'all', count: counts.all },
    { id: 'active', label: 'active', count: counts.active },
    { id: 'inactive', label: 'inactive', count: counts.inactive },
    { id: 'bundled', label: 'bundled', count: counts.bundled },
    { id: 'modified', label: 'modified', count: counts.modified },
  ];
});

function clearFilters(): void {
  search.value = '';
  statusFilter.value = 'all';
}
const isPending = computed(() => listQuery.isPending.value || bundledQuery.isPending.value);
const isError = computed(() => listQuery.isError.value || bundledQuery.isError.value);
function refetch(): void {
  void listQuery.refetch();
  void bundledQuery.refetch();
}

// ── New-rule affordance ───────────────────────────────────────────
//
// MAL/LAL catalogs are operator-writable; OAL is read-only upstream.
// Show a "+ new rule" inline form on writable catalogs that takes a
// name, validates it, and routes to the editor with an empty buffer
// for the operator to author + addOrUpdate.

// OAL has its own read-only browse view at `/oal`; the writable
// catalog browse only ever resolves a `Catalog` (MAL or LAL).
const isWritableCatalog = computed(() => catalog.value !== null);

const showNewForm = ref<boolean>(false);
const newRuleName = ref<string>('');
const newRuleError = ref<string | null>(null);

/** Same shape upstream's runtime-rule receiver enforces — `[A-Za-z0-9._/-]+`
 *  with a minimum length and no leading/trailing slash. Pre-flight here
 *  saves an OAP round-trip for typos. */
const NEW_RULE_NAME_RE = /^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,128}[A-Za-z0-9._-]$|^[A-Za-z0-9._-]$/;

function startNewRule(): void {
  newRuleError.value = null;
  newRuleName.value = '';
  showNewForm.value = true;
}

function cancelNewRule(): void {
  showNewForm.value = false;
  newRuleError.value = null;
  newRuleName.value = '';
}

function submitNewRule(): void {
  const c = catalog.value;
  if (!c) return;
  const name = newRuleName.value.trim();
  if (!name) {
    newRuleError.value = 'name is required';
    return;
  }
  if (!NEW_RULE_NAME_RE.test(name)) {
    newRuleError.value =
      'name must use letters, digits, dots, underscores, dashes, or slashes';
    return;
  }
  // Collision check against the merged list — ACTIVE/INACTIVE rows
  // and bundled rows alike. Operator should hit "edit" on an existing
  // rule rather than overwrite via the new-rule path.
  if (mergedRules.value.some((r) => r.name === name)) {
    newRuleError.value = `rule "${name}" already exists — open it from the grid to edit`;
    return;
  }
  showNewForm.value = false;
  void router.push({
    name: 'edit',
    query: { catalog: c, name },
  });
}
</script>

<template>
  <div class="catalog">
    <AdminFeatureWarning module="receiver-runtime-rule" feature-label="DSL management" />
    <header class="catalog__header">
      <h1 class="catalog__h1">
        Catalog · <span class="catalog__catalog">{{ catalog ?? 'unknown' }}</span>
      </h1>
      <Pill v-if="ruleCount > 0" tone="dim">{{ ruleCount }} rules</Pill>
      <Pill v-if="bundledCount > 0" tone="dim">{{ bundledCount }} bundled</Pill>
      <Btn
        size="sm"
        :disabled="isPending"
        title="re-pull this catalog from OAP"
        @click="refetch()"
      >{{ isPending ? 'refreshing…' : 'refresh' }}</Btn>
      <span v-if="isWritableCatalog" class="catalog__newslot">
        <Btn
          v-if="!showNewForm"
          kind="primary"
          size="sm"
          data-testid="catalog-new-rule"
          @click="startNewRule"
        >+ new rule</Btn>
        <form
          v-else
          class="catalog__newform"
          @submit.prevent="submitNewRule"
        >
          <input
            v-model="newRuleName"
            class="catalog__newinput"
            type="text"
            placeholder="new rule name…"
            autofocus
            data-testid="catalog-new-rule-name"
          />
          <Btn kind="primary" size="sm" type="submit">create</Btn>
          <Btn kind="ghost" size="sm" type="button" @click="cancelNewRule">cancel</Btn>
        </form>
      </span>
    </header>

    <p v-if="newRuleError" class="catalog__newerr">{{ newRuleError }}</p>

    <div v-if="catalog === null" class="catalog__empty">
      Unknown catalog. Pick one from the left nav.
    </div>

    <div v-else-if="isPending" class="catalog__skeletons">
      <div v-for="n in 6" :key="n" class="catalog__skeleton" />
    </div>

    <div v-else-if="isError" class="catalog__error">
      Could not load <code>{{ catalog }}</code>.
      <button class="catalog__retry" type="button" @click="refetch()">retry</button>
    </div>

    <div v-else-if="ruleCount === 0" class="catalog__empty">
      <p>No rules in this catalog yet.</p>
      <p class="catalog__hint">
        Push one with <code>POST /runtime/rule/addOrUpdate</code> or its
        <code>swctl</code> equivalent.
      </p>
    </div>

    <template v-else>
      <div class="catalog__filters">
        <div class="catalog__searchbox">
          <input
            v-model="search"
            class="catalog__search"
            type="search"
            placeholder="filter by name…"
            data-testid="catalog-search"
          />
          <span v-if="search" class="catalog__searchcount">
            {{ filteredCount }} / {{ ruleCount }}
          </span>
        </div>
        <div class="catalog__statusfacets">
          <button
            v-for="f in statusFacets"
            :key="f.id"
            type="button"
            class="catalog__facet"
            :class="{ 'catalog__facet--active': statusFilter === f.id }"
            :disabled="f.count === 0 && f.id !== 'all'"
            @click="statusFilter = f.id"
          >
            {{ f.label }}
            <span class="catalog__facetcount">{{ f.count }}</span>
          </button>
        </div>
        <button
          v-if="search || statusFilter !== 'all'"
          type="button"
          class="catalog__clear"
          @click="clearFilters"
        >clear</button>
      </div>

      <div v-if="filteredCount === 0" class="catalog__empty">
        No rules match the current filter.
      </div>

      <section v-for="g in groups" :key="g.group" class="group">
        <header class="group__header">
          <span class="group__kicker">{{ g.group }}</span>
          <span class="group__count">{{ g.rules.length }}</span>
        </header>
        <div class="group__cards">
          <RuleCard v-for="rule in g.rules" :key="`${rule.catalog}/${rule.name}`" :rule="rule" />
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.catalog {
  padding: 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 1400px;
}

.catalog__newslot {
  margin-left: auto;
}

.catalog__newform {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.catalog__newinput {
  background: var(--rr-bg2);
  color: var(--rr-ink);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-md);
  padding: 5px 10px;
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  min-width: 260px;
}
.catalog__newinput:focus {
  outline: 1px solid var(--rr-active);
  outline-offset: -1px;
  border-color: var(--rr-active);
}

.catalog__newerr {
  margin: 0;
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  color: var(--rr-err);
}

.catalog__filters {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 8px 12px;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-md);
}

.catalog__searchbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 280px;
  min-width: 240px;
}

.catalog__search {
  flex: 1 1 auto;
  min-width: 200px;
  background: var(--rr-bg);
  color: var(--rr-ink);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-md);
  padding: 5px 10px;
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
}
.catalog__search:focus {
  outline: 1px solid var(--rr-active);
  outline-offset: -1px;
  border-color: var(--rr-active);
}

.catalog__searchcount {
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  color: var(--rr-dim);
  letter-spacing: 0.4px;
}

.catalog__statusfacets {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
}

.catalog__facet {
  background: transparent;
  border: 1px solid var(--rr-border);
  color: var(--rr-ink2);
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  padding: 3px 10px;
  cursor: pointer;
  border-radius: var(--rr-radius-md);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  letter-spacing: 0.3px;
}
.catalog__facet:hover:not(:disabled) {
  color: var(--rr-ink);
  border-color: var(--rr-border2);
}
.catalog__facet:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.catalog__facet--active {
  background: var(--rr-bg3);
  color: var(--rr-active);
  border-color: var(--rr-active);
}
.catalog__facetcount {
  color: var(--rr-dim);
  font-size: 11.5px;
}
.catalog__facet--active .catalog__facetcount {
  color: var(--rr-active);
}

.catalog__clear {
  background: transparent;
  border: 0;
  color: var(--rr-dim);
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  cursor: pointer;
  padding: 3px 6px;
  text-decoration: underline;
}
.catalog__clear:hover {
  color: var(--rr-active);
}

.catalog__header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.catalog__h1 {
  margin: 0;
  font-family: var(--rr-font-ui);
  font-weight: 500;
  font-size: 14px;
  color: var(--rr-heading);
}

.catalog__catalog {
  font-family: var(--rr-font-mono);
  color: var(--rr-active);
}

.catalog__empty,
.catalog__error {
  font-family: var(--rr-font-mono);
  font-size: 12px;
  color: var(--rr-ink2);
  padding: 32px 0;
}

.catalog__hint {
  font-size: 11.5px;
  color: var(--rr-dim);
}

.catalog__error code,
.catalog__hint code {
  font-family: var(--rr-font-mono);
  color: var(--rr-info);
}

.catalog__retry {
  margin-left: 8px;
  background: transparent;
  color: var(--rr-active);
  border: 1px solid var(--rr-active);
  padding: 2px 8px;
  border-radius: var(--rr-radius-md);
  cursor: pointer;
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
}
.catalog__retry:hover {
  background: color-mix(in oklch, var(--rr-active) 15%, transparent);
}

.catalog__skeletons {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.catalog__skeleton {
  width: 240px;
  height: 78px;
  border-radius: var(--rr-radius-md);
  background: linear-gradient(
    90deg,
    var(--rr-bg2) 0%,
    var(--rr-bg3) 50%,
    var(--rr-bg2) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s linear infinite;
}

@keyframes shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -100% 0;
  }
}

.group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.group__header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  border-bottom: 1px solid var(--rr-border);
  padding-bottom: 4px;
}

.group__kicker {
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--rr-dim);
}

.group__count {
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  color: var(--rr-dim);
}

.group__cards {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
</style>
