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
  Operate › Alerting Rules. Read-only catalog of every alarm rule
  loaded into the OAP cluster, with per-rule body + per-OAP-node
  load state.

  Layout:
   ┌── filter ─────────────────────────────────────────────────┐
   │ search: [_______________]                                  │
   ├── list ─────────────────┬── detail ──────────────────────┤
   │ service_resp_time_rule  │ rule body (period, silence,    │
   │   bundled · loaded 3/3  │   recovery, hooks, metrics)     │
   │ jvm_old_gen_rule        │ trigger expression              │
   │   bundled · loaded 3/3  │ per-OAP-node load state         │
   │ …                       │ running entities                │
   └─────────────────────────┴────────────────────────────────┘

  Read-only by design — alarm-rule edits go through the YAML file +
  OAP restart (or watcher reload). No buttons to add / change / delete
  rules here.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { bff, type AlertingRuleSummary } from '@/api/client';

const route = useRoute();
const router = useRouter();

const listQuery = useQuery({
  queryKey: ['operate/alerting-rules'],
  queryFn: () => bff.alarms.adminRules(),
  staleTime: 30_000,
  refetchOnWindowFocus: false,
});

const search = ref<string>('');

/* Selected rule is URL-driven via `?id=…` so deep-links from the
 * detail panel (`view in catalog →`) land on a specific rule. */
const selectedId = computed<string>({
  get: () => (typeof route.query.id === 'string' ? route.query.id : ''),
  set: (v: string) => {
    router.replace({ query: { ...route.query, id: v || undefined } });
  },
});

const rules = computed<AlertingRuleSummary[]>(() => listQuery.data.value?.rules ?? []);
const filteredRules = computed<AlertingRuleSummary[]>(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rules.value;
  return rules.value.filter((r) => {
    if (r.ruleId.toLowerCase().includes(q)) return true;
    const expr = r.detail?.expression ?? '';
    return expr.toLowerCase().includes(q);
  });
});

/* Auto-select the first rule on load when nothing is URL-pinned, so
 * the detail pane never sits empty after the list arrives. */
watch(
  () => filteredRules.value,
  (list) => {
    if (!selectedId.value && list.length > 0) {
      selectedId.value = list[0]!.ruleId;
    }
  },
);

const selectedSummary = computed<AlertingRuleSummary | null>(() => {
  if (!selectedId.value) return null;
  return rules.value.find((r) => r.ruleId === selectedId.value) ?? null;
});

const detailQuery = useQuery({
  queryKey: computed(() => ['operate/alerting-rule', selectedId.value]),
  queryFn: () => bff.alarms.adminRule(selectedId.value),
  enabled: computed(() => selectedId.value.length > 0),
  staleTime: 30_000,
});

const detail = computed(() => detailQuery.data.value?.detail ?? selectedSummary.value?.detail ?? null);
const detailNodes = computed(() => detailQuery.data.value?.nodes ?? []);
</script>

<template>
  <div class="ar">
    <header class="ar__head">
      <div>
        <div class="ar__kicker">Operate · Alerting</div>
        <h1>Alerting rules</h1>
        <p class="ar__lede">
          Read-only catalog of every alarm rule loaded by OAP, with its body and per-node load
          state. Rules edit through OAP's <code>alarm-settings.yml</code> + watcher reload —
          there's no mutation surface here by design.
        </p>
      </div>
      <div class="ar__head-actions">
        <button
          type="button"
          class="ar__refresh"
          :disabled="listQuery.isFetching.value"
          @click="listQuery.refetch()"
        >{{ listQuery.isFetching.value ? 'refreshing…' : 'refresh' }}</button>
      </div>
    </header>

    <div v-if="listQuery.isPending.value" class="ar__empty">loading…</div>

    <div v-else-if="listQuery.data.value && !listQuery.data.value.reachable" class="ar__empty ar__empty--err">
      Admin server unreachable —
      <code>{{ listQuery.data.value.error ?? 'no response' }}</code>.
      Check the <code>SW_ADMIN_SERVER</code> selector and the BFF's <code>oap.adminUrl</code>.
    </div>

    <template v-else>
      <div class="ar__filter">
        <input
          v-model="search"
          type="text"
          placeholder="search rule id or expression…"
          class="ar__search"
        />
        <span class="ar__count">{{ filteredRules.length }} rule{{ filteredRules.length === 1 ? '' : 's' }}</span>
      </div>

      <div class="ar__split">
        <ul class="ar__list">
          <li
            v-for="r in filteredRules"
            :key="r.ruleId"
            class="ar__list-item"
            :class="{ active: r.ruleId === selectedId }"
            @click="selectedId = r.ruleId"
          >
            <div class="ar__list-name">
              <code>{{ r.ruleId }}</code>
            </div>
            <div class="ar__list-meta">
              <span class="ar__load" :class="{ partial: r.loadedOn < r.totalNodes }">
                loaded {{ r.loadedOn }}/{{ r.totalNodes }}
              </span>
              <span v-if="r.detail?.period" class="ar__period">
                {{ r.detail.period }}m window
              </span>
            </div>
          </li>
          <li v-if="filteredRules.length === 0" class="ar__list-empty">
            No rules match.
          </li>
        </ul>

        <aside class="ar__detail">
          <div v-if="!selectedSummary && !detail" class="ar__placeholder">
            Select a rule to see its body.
          </div>
          <template v-else>
            <header class="ar__detail-head">
              <h2><code>{{ selectedId }}</code></h2>
            </header>

            <div v-if="detailQuery.isPending.value && !detail" class="ar__placeholder">loading…</div>
            <div v-else-if="!detail" class="ar__placeholder">
              Rule body unavailable on every node.
            </div>
            <template v-else>
              <section class="ar__sec">
                <div class="ar__kicker-s">Expression</div>
                <pre class="ar__expr">{{ detail.expression }}</pre>
              </section>

              <section class="ar__sec">
                <div class="ar__kicker-s">Window</div>
                <div class="ar__meta-grid">
                  <div><span class="ar__lbl">period</span><span>{{ detail.period }}m</span></div>
                  <div><span class="ar__lbl">silence</span><span>{{ detail.silencePeriod }}m</span></div>
                  <div><span class="ar__lbl">recovery-obs</span><span>{{ detail.recoveryObservationPeriod }}m</span></div>
                  <div v-if="detail.additionalPeriod > 0">
                    <span class="ar__lbl">additional</span><span>{{ detail.additionalPeriod }}m</span>
                  </div>
                </div>
              </section>

              <section v-if="detail.includeMetrics.length > 0" class="ar__sec">
                <div class="ar__kicker-s">Metrics referenced</div>
                <div class="ar__chips">
                  <code v-for="m in detail.includeMetrics" :key="m">{{ m }}</code>
                </div>
              </section>

              <section v-if="detail.hooks.length > 0" class="ar__sec">
                <div class="ar__kicker-s">Hooks</div>
                <div class="ar__chips">
                  <span v-for="h in detail.hooks" :key="h" class="ar__tag">{{ h }}</span>
                </div>
              </section>

              <section v-if="detail.tags.length > 0" class="ar__sec">
                <div class="ar__kicker-s">Tags</div>
                <div class="ar__chips">
                  <span v-for="t in detail.tags" :key="`${t.key}=${t.value}`" class="ar__tag">
                    {{ t.key }}={{ t.value }}
                  </span>
                </div>
              </section>

              <section
                v-if="detail.includeEntityNames.length > 0 || detail.includeEntityNamesRegex"
                class="ar__sec"
              >
                <div class="ar__kicker-s">Include entities</div>
                <div v-if="detail.includeEntityNamesRegex" class="ar__regex">
                  regex: <code>{{ detail.includeEntityNamesRegex }}</code>
                </div>
                <div v-if="detail.includeEntityNames.length > 0" class="ar__chips">
                  <code v-for="n in detail.includeEntityNames" :key="n">{{ n }}</code>
                </div>
              </section>

              <section
                v-if="detail.excludeEntityNames.length > 0 || detail.excludeEntityNamesRegex"
                class="ar__sec"
              >
                <div class="ar__kicker-s">Exclude entities</div>
                <div v-if="detail.excludeEntityNamesRegex" class="ar__regex">
                  regex: <code>{{ detail.excludeEntityNamesRegex }}</code>
                </div>
                <div v-if="detail.excludeEntityNames.length > 0" class="ar__chips">
                  <code v-for="n in detail.excludeEntityNames" :key="n">{{ n }}</code>
                </div>
              </section>

              <section v-if="detail.runningEntities.length > 0" class="ar__sec">
                <div class="ar__kicker-s">
                  Currently watching ({{ detail.runningEntities.length }})
                </div>
                <ul class="ar__entity-list">
                  <li v-for="re in detail.runningEntities" :key="`${re.scope}/${re.name}`">
                    <span class="ar__tag">{{ re.scope }}</span>
                    <code>{{ re.name }}</code>
                  </li>
                </ul>
              </section>

              <section v-if="detailNodes.length > 1" class="ar__sec">
                <div class="ar__kicker-s">Per-node state</div>
                <table class="ar__node-table">
                  <thead>
                    <tr>
                      <th>node</th>
                      <th>ok</th>
                      <th>note</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="n in detailNodes" :key="n.address">
                      <td><code>{{ n.address }}</code></td>
                      <td>
                        <span class="ar__dot" :class="n.ok ? 'is-ok' : 'is-err'" />
                        {{ n.ok ? 'ok' : 'err' }}
                      </td>
                      <td class="ar__node-note">{{ n.error ?? (n.detail ? '—' : 'no body returned') }}</td>
                    </tr>
                  </tbody>
                </table>
              </section>
            </template>
          </template>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ar {
  padding: 20px 20px 60px;
  max-width: 1500px;
  margin: 0 auto;
}
.ar__head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}
.ar__head > div:first-child { flex: 1; }
.ar__kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  margin-bottom: 4px;
}
.ar h1 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.ar__lede {
  font-size: 12.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 820px;
}
.ar__lede code {
  font-family: var(--sw-mono);
  font-size: 11.5px;
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.ar__refresh {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
}
.ar__refresh:not(:disabled):hover { background: var(--sw-bg-2); border-color: var(--sw-accent); }
.ar__refresh:disabled { opacity: 0.55; cursor: not-allowed; }

.ar__empty {
  padding: 32px;
  text-align: center;
  font-size: 12px;
  color: var(--sw-fg-3);
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line);
  border-radius: 8px;
}
.ar__empty--err {
  color: var(--sw-err);
  border-color: rgba(239,68,68,0.4);
}
.ar__empty code {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}

.ar__filter {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 8px 10px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
}
.ar__search {
  flex: 1;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 5px;
  outline: none;
}
.ar__search:focus { border-color: var(--sw-accent); }
.ar__count {
  font-size: 11px;
  color: var(--sw-fg-3);
  font-variant-numeric: tabular-nums;
}

.ar__split {
  display: grid;
  grid-template-columns: 380px 1fr;
  gap: 16px;
  align-items: start;
}
.ar__list {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  overflow: hidden;
  max-height: calc(100vh - 220px);
  overflow-y: auto;
}
.ar__list-item {
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
}
.ar__list-item:last-child { border-bottom: none; }
.ar__list-item:hover { background: var(--sw-bg-2); }
.ar__list-item.active {
  background: var(--sw-bg-3);
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.ar__list-name code {
  font-family: var(--sw-mono);
  font-size: 12px;
  color: var(--sw-fg-0);
  background: transparent;
  padding: 0;
}
.ar__list-meta {
  margin-top: 4px;
  display: flex;
  gap: 10px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.ar__load.partial { color: var(--sw-warn); }
.ar__period { font-variant-numeric: tabular-nums; }
.ar__list-empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--sw-fg-3);
}

.ar__detail {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: calc(100vh - 220px);
  overflow-y: auto;
}
.ar__placeholder {
  padding: 32px;
  text-align: center;
  font-size: 12px;
  color: var(--sw-fg-3);
}
.ar__detail-head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.ar__detail-head h2 code {
  font-family: var(--sw-mono);
  color: var(--sw-fg-0);
  background: transparent;
  font-size: 13px;
}
.ar__sec { border-top: 1px solid var(--sw-line); padding-top: 12px; }
.ar__sec:first-of-type { border-top: 0; padding-top: 0; }
.ar__kicker-s {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
  margin-bottom: 6px;
}
.ar__expr {
  font-family: var(--sw-mono);
  font-size: 12px;
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  padding: 10px 12px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
}
.ar__meta-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}
.ar__meta-grid > div {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.ar__lbl {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
}
.ar__chips { display: flex; flex-wrap: wrap; gap: 4px; }
.ar__chips code {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--sw-line);
}
.ar__tag {
  font-size: 10.5px;
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--sw-line);
}
.ar__regex { font-size: 11px; color: var(--sw-fg-2); margin-bottom: 6px; }
.ar__regex code {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.ar__entity-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ar__entity-list li {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ar__entity-list code {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.ar__node-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.ar__node-table th, .ar__node-table td {
  text-align: left;
  padding: 5px 8px;
  border-bottom: 1px solid var(--sw-line);
}
.ar__node-table th {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
}
.ar__node-table code {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-1);
}
.ar__node-note { color: var(--sw-fg-3); font-style: italic; max-width: 320px; overflow-wrap: anywhere; }
.ar__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}
.ar__dot.is-ok { background: var(--sw-ok); }
.ar__dot.is-err { background: var(--sw-err); }
</style>
