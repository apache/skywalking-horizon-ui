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
  Admin / Layer dashboards. List every loaded layer template, pick one
  on the left, edit its per-scope widget set on the right. Saves go
  through the template-sync store (bff.templateSync.save) which persists
  to OAP and refreshes the BFF's in-memory cache.

  Widget editor presents the new span-based fields (12-col flow
  layout): operator picks a column span, optional row span, MQE
  expressions, type, title, unit, and an optional visibility predicate.
  Legacy x/y/w/h are NOT shown — they're kept on the wire for
  back-compat with older JSONs but operators don't edit them.

  XL file; decomposition is staged — geometry helpers are extracted
  (layer-dashboards.geometry.ts); MetricDefinitionRow + composables pending.
-->
<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import type { AdminLayerTemplate } from '@/api/client';
import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';

import SyncStatusBanner from '@/features/admin/_shared/SyncStatusBanner.vue';
import Modal from '@/features/operate/_shared/Modal.vue';
import MonacoDiff from '@/features/operate/_shared/MonacoDiff.vue';
import DependencyConfigSection from './DependencyConfigSection.vue';
import ProcessConfigEditor from './ProcessConfigEditor.vue';
import TopologyConfigEditor from './TopologyConfigEditor.vue';
import DeploymentConfigEditor from './DeploymentConfigEditor.vue';
import LayerSetupEditor from './LayerSetupEditor.vue';
import ServiceListMetricsEditor from './ServiceListMetricsEditor.vue';
import LayerBrowseRail from './LayerBrowseRail.vue';
import LayerHeaderBar from './LayerHeaderBar.vue';
import ScopeTabsBar from './ScopeTabsBar.vue';
import WidgetEditorCanvas from './WidgetEditorCanvas.vue';
import {
  type AdminScope,
  SCOPES,
  RUNTIME_ONLY_SCOPES,
  SCOPE_COMPONENT,
  scopeLabelOf,
} from './layer-dashboards.scopes';
import { useLayerTemplateStore } from './useLayerTemplateStore';

// Template-store spine + lifecycle (draft, sources, save/push/disable). The
// parent is the single caller; child components below receive these as props.
const {
  sync,
  t,
  draft,
  selectedKey,
  activeScope,
  editorSource,
  selectedTpl,
  editName,
  templates,
  unconfiguredCount,
  divergedCount,
  localCount,
  layerSyncBanner,
  isLoading,
  error,
  isSaving,
  saveMsg,
  refreshingFromRemote,
  isDivergedRow,
  isUnconfiguredRow,
  refreshFromRemote,
  sourcesReady,
  hasLocalDraft,
  remoteAvailable,
  bundledExists,
  isSynced,
  hasLocalDraftFor,
  resetTo,
  previewLive,
  dirty,
  editorDiffersFromRemote,
  localDiffersFromRemote,
  canExport,
  save,
  pushToOap,
  pushDiffOpen,
  pushLocalPretty,
  pushRemotePretty,
  onExport,
  onImportFile,
  isLayerDisabled,
  deleteOpen,
  confirmTitle,
  confirmMessage,
  confirmLabel,
  confirmIsDanger,
  runConfirm,
  askDeleteLayer,
  askReactivateLayer,
} = useLayerTemplateStore();

const activeScopeRuntimeOnly = computed(() => RUNTIME_ONLY_SCOPES.has(activeScope.value));

/** When false the browse rail is hidden entirely and layer switching
 *  moves to the top dropdown inside the editor — the editor claims the
 *  full width. Defaults collapsed; the rail is an opt-in browse mode.
 *  Two-way bound to LayerBrowseRail, which collapses it on a rail pick. */
const layerListOpen = ref(false);

const visibleScopes = computed<AdminScope[]>(() => {
  const tpl = draft.template;
  if (!tpl?.components) return SCOPES;
  return SCOPES.filter((s) => tpl.components[SCOPE_COMPONENT[s]]);
});
watch(visibleScopes, (scopes) => {
  // If the currently-active scope was just toggled off, snap to the
  // first remaining visible scope so the editor stays on solid ground.
  if (!scopes.includes(activeScope.value)) {
    activeScope.value = scopes[0] ?? 'service';
  }
});

function widgetsFor(scope: AdminScope): DashboardWidget[] {
  const tpl = draft.template;
  if (!tpl) return [];
  // Read from `dashboards.<scope>`, falling back to legacy `widgets`
  // for the service scope so the existing JSONs keep their content
  // until we explicitly migrate them.
  const scoped = tpl.dashboards?.[scope];
  if (scoped) return scoped;
  if (scope === 'service' && tpl.widgets) return tpl.widgets;
  return [];
}

// Instance-topology drill-down config (optional, nested under topology).
const instanceTopologyEnabled = computed(() => !!draft.template?.topology?.instanceTopology);


/* Trace backend selector. `traces.source` decides which trace store the
 * per-layer Trace tab dispatches to: `native` (SkyWalking query-protocol),
 * `zipkin` (Envoy ALS / rover spans), or `both` (parallel tables). The
 * field IS live — `LayerTracesEntry` reads `layer.traces.source` at
 * runtime — so it belongs in the config UI. Default `both` when unset. */
type TraceSource = 'native' | 'zipkin' | 'both';
const traceSource = computed<TraceSource>({
  get: () => draft.template?.traces?.source ?? 'both',
  set: (v: TraceSource) => {
    if (!draft.template) return;
    if (draft.template.traces) draft.template.traces.source = v;
    else draft.template.traces = { source: v };
  },
});
const TRACE_SOURCE_OPTIONS: Array<{ value: TraceSource; label: string; hint: string }> = [
  { value: 'native', label: 'Native', hint: 'SkyWalking query-protocol traces (agent-instrumented).' },
  { value: 'zipkin', label: 'OpenTelemetry & Zipkin', hint: 'Traces emitted from the OpenTelemetry & Zipkin ecosystem.' },
  { value: 'both', label: 'Both', hint: 'Layer carries both native and OpenTelemetry/Zipkin traces — their span formats and query conditions differ, so each gets its own trace tab.' },
];

/* Logs has no per-layer config beyond the enable/disable Components
 * toggle. Trace carries one setting — `traces.source` (native / zipkin /
 * both), edited via `traceSource` above — which the per-layer Trace tab
 * honors at runtime to pick the trace backend. */

/** Menu-preview click: focus the component's scope (if surfaced) and
 *  scroll the scope editor into view so config + preview follow the
 *  selection. */
function jumpToComponent(scope: AdminScope): void {
  if (visibleScopes.value.includes(scope)) activeScope.value = scope;
  void nextTick(() => {
    document.getElementById('scope-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function scopeLabel(s: AdminScope): string {
  return scopeLabelOf(draft.template, s);
}
// Alias-aware nouns for the topology editor: a service-topology node IS
// a service, an instance-topology node IS an instance — so their section
// headings read in the layer's own vocabulary (e.g. "Pods", "Sidecars").
const serviceNoun = computed(() => scopeLabel('service'));
const instanceNoun = computed(() => scopeLabel('instance'));

function setVisibility(v: 'public' | 'operate'): void {
  if (!draft.template) return;
  // `public` is the implicit default — drop the field rather than
  // emit a redundant value, so saved JSON stays minimal.
  if (v === 'public') {
    delete (draft.template as { visibility?: string }).visibility;
  } else {
    (draft.template as { visibility?: string }).visibility = 'operate';
  }
}

// Topology cluster setup — rule editor + live tester.
// The rule is a named-capture regex run against every service name in
// the topology + service pickers. Operators bind which capture maps to
// the display label vs the cluster value (e.g. k8s namespace), and
// pick a human-readable alias (`namespace`, `tenant`, …). The tester
// evaluates the live draft against a sample name so operators can see
// the resolved `{ display, cluster, alias }` before saving. Distinct
// from OAP's layer-agnostic `<group>::<base>` prefix (which is a
// global naming convention, never produces a cluster box).
type NamingRule = NonNullable<AdminLayerTemplate['naming']>;
function namingDefault(): NamingRule {
  return {
    pattern: '^(?<service>[^.]+)\\.(?<namespace>[^.]+)(?:\\..*)?$',
    flags: '',
    displayGroup: 'service',
    valueGroup: 'namespace',
    alias: 'namespace',
  };
}
function enableNaming(): void {
  if (!draft.template) return;
  draft.template.naming = namingDefault();
}
function disableNaming(): void {
  if (!draft.template) return;
  draft.template.naming = undefined;
}

const namingSample = ref<string>('songs.sample.svc.cluster.local');
interface NamingTestResult {
  ok: boolean;
  display: string | null;
  group: string | null;
  alias: string | null;
  error: string | null;
}
const namingTest = computed<NamingTestResult>(() => {
  const rule = draft.template?.naming;
  if (!rule) return { ok: false, display: null, group: null, alias: null, error: 'no rule configured' };
  if (!rule.pattern) return { ok: false, display: null, group: null, alias: null, error: 'pattern required' };
  let re: RegExp;
  try {
    re = new RegExp(rule.pattern, rule.flags ?? '');
  } catch (err) {
    return { ok: false, display: null, group: null, alias: null, error: err instanceof Error ? err.message : 'invalid regex' };
  }
  const m = namingSample.value.match(re);
  if (!m || !m.groups) {
    return { ok: false, display: null, group: null, alias: rule.alias, error: 'no match' };
  }
  const displayKey = rule.displayGroup || 'service';
  const valueKey = rule.valueGroup || 'group';
  const display = m.groups[displayKey] ?? null;
  const group = m.groups[valueKey] ?? null;
  if (!display && !group) {
    return { ok: false, display: null, group: null, alias: rule.alias, error: `neither capture "${displayKey}" nor "${valueKey}" resolved` };
  }
  return { ok: true, display, group, alias: rule.alias, error: null };
});
</script>

<template>
  <div class="admin-page">
    <header class="page-head">
      <div>
        <div class="kicker">{{ t('Admin') }}</div>
        <h1>{{ t('Layer dashboards') }}</h1>
        <p class="lede">
          {{ t('Each layer ships with a JSON template (alias, components, metric columns, widgets). Pick a layer on the left, switch scopes (service / instance / endpoint / trace / profiling), edit widgets in place. Edits write to OAP via the UI-template REST surface — bundled JSON is the seed + read-only fallback.') }}
        </p>
      </div>
    </header>

    <SyncStatusBanner :banner="layerSyncBanner" />

    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="isLoading" class="empty">Loading templates…</div>
    <div v-else-if="templates.length === 0" class="empty">No layer templates loaded.</div>

    <div v-else class="grid" :class="{ 'list-collapsed': !layerListOpen }">
      <!-- Layer browse surface: the pinned left rail when expanded, the
           compact dropdown switcher at the top of the editor pane when
           collapsed. Owns the search + diverged/local/not-configured
           filters; selecting a layer (or row) writes selectedKey and
           collapses the rail. -->
      <LayerBrowseRail
        v-model:selected-key="selectedKey"
        v-model:layer-list-open="layerListOpen"
        :templates="templates"
        :selected-tpl="selectedTpl"
        :diverged-count="divergedCount"
        :local-count="localCount"
        :unconfigured-count="unconfiguredCount"
        :refreshing="refreshingFromRemote"
        :read-only="sync.readOnly.value"
        :badge-for="sync.badgeFor"
        :is-diverged="isDivergedRow"
        :is-unconfigured="isUnconfiguredRow"
        :has-local-draft-for="hasLocalDraftFor"
        @refresh="refreshFromRemote"
      />

      <main v-if="selectedTpl" class="detail">
        <!-- Identity / action header: name + key + sync status, Disable /
             Reactivate, source pill, Export / Import, Reset-to + Preview
             dropdowns, Publish + Save, flash message, sidebar placement. -->
        <LayerHeaderBar
          :selected-tpl="selectedTpl"
          :badge="sync.badgeFor(editName)"
          :read-only="sync.readOnly.value"
          :has-local-draft="hasLocalDraft"
          :is-layer-disabled="isLayerDisabled"
          :is-saving="isSaving"
          :remote-available="remoteAvailable"
          :bundled-exists="bundledExists"
          :sources-ready="sourcesReady"
          :editor-source="editorSource"
          :can-export="canExport"
          :is-synced="isSynced"
          :local-differs-from-remote="localDiffersFromRemote"
          :dirty="dirty"
          :editor-differs-from-remote="editorDiffersFromRemote"
          :save-msg="saveMsg"
          @reactivate="askReactivateLayer"
          @delete="askDeleteLayer"
          @export="onExport"
          @import="onImportFile"
          @reset="resetTo"
          @preview="previewLive"
          @push="pushDiffOpen = true"
          @save="save"
          @set-visibility="setVisibility"
        />

        <!-- Layer setup: live menu preview + alias + components + menu-label
             editors. Clicking a preview item emits `jump`; the parent owns the
             activeScope write + scroll via jumpToComponent. -->
        <LayerSetupEditor
          v-model:template="selectedTpl"
          :active-scope="activeScope"
          :instance-topology-enabled="instanceTopologyEnabled"
          @jump="jumpToComponent"
        />


        <!-- Service-list metrics: the columns shown in the picker
             zone's services table + the default sort. Used across
             the per-layer page. -->
        <ServiceListMetricsEditor
          v-model:config="selectedTpl.metrics"
          :service-label="serviceNoun"
        />

        <ScopeTabsBar
          v-model:active-scope="activeScope"
          :visible-scopes="visibleScopes"
          :label-for="scopeLabel"
          :widgets-for="widgetsFor"
        />

        <!-- Widget editor: canvas + drawer.
             Canvas (left): 12-col grid background, widgets placed at
             their span/rowSpan. Click selects, drag header reorders,
             drag bottom-right corner resizes. Previews use mock data
             so the layout reads as a real dashboard without firing
             MQE per keystroke.
             Drawer (right): config fields for the selected widget.
             Hidden when nothing is selected so the canvas gets the
             full width. -->
        <!-- Topology cluster setup: a named-capture regex run against
             every service name. The topology view buckets nodes by the
             resolved cluster value (e.g. k8s namespace) and renders an
             `<alias · value>` chip next to the service display label.
             Distinct from the layer-agnostic OAP `<group>::<base>`
             prefix convention, which is global and never produces a
             topology cluster — clusters are explicit per-layer opt-in.
             Live tester at the bottom evaluates the current draft
             against a sample name so the operator can see the result
             before saving. -->
        <section
          v-if="selectedTpl.components?.topology && activeScope === 'topology'"
          class="sw-card components-card"
        >
          <div class="card-head">
            <h4>Topology cluster setup</h4>
            <span class="sub">parse service name → display label + cluster dimension (k8s/mesh namespace, tenant, fleet, …)</span>
            <button
              v-if="!selectedTpl.naming"
              class="sw-btn add"
              type="button"
              @click="enableNaming"
            >＋ Enable rule</button>
            <button
              v-else
              class="sw-btn small ghost danger"
              type="button"
              @click="disableNaming"
            >Remove rule</button>
          </div>
          <div v-if="!selectedTpl.naming" class="topo-cfg-help" style="padding: 12px 16px;">
            No cluster rule configured — the topology view renders without cluster bounding
            boxes. Enable a rule for layers whose service names encode a cluster dimension
            (k8s namespace, fleet, tenant) so topology can cluster nodes accordingly.
          </div>
          <div v-else class="naming-body">
            <div class="naming-row">
              <label class="mf mf-wide">
                <span>regex pattern</span>
                <input
                  v-model="selectedTpl.naming.pattern"
                  class="mf-input mono"
                  type="text"
                  spellcheck="false"
                  placeholder="^(?<service>[^.]+)\.(?<namespace>[^.]+)$"
                />
              </label>
              <label class="mf mf-narrow" title="JavaScript regex flags: i = case-insensitive, m = multiline, s = dotall, u = unicode. Service names are case-sensitive single-line strings, so this is almost always empty.">
                <span>regex flags</span>
                <input
                  v-model="selectedTpl.naming.flags"
                  class="mf-input mono"
                  type="text"
                  spellcheck="false"
                  placeholder="(empty)"
                />
              </label>
            </div>
            <div class="naming-flags-hint">
              <code>flags</code> are passed as the second argument to
              <code>new RegExp(pattern, flags)</code>. Common values: <code>i</code>
              (case-insensitive), <code>m</code> (multiline). Leave empty for typical
              k8s/mesh service names.
            </div>
            <div class="naming-row">
              <label class="mf">
                <span>display capture</span>
                <input
                  v-model="selectedTpl.naming.displayGroup"
                  class="mf-input mono"
                  type="text"
                  placeholder="service"
                />
              </label>
              <label class="mf">
                <span>cluster capture</span>
                <input
                  v-model="selectedTpl.naming.valueGroup"
                  class="mf-input mono"
                  type="text"
                  placeholder="namespace"
                />
              </label>
              <label class="mf">
                <span>alias (cluster label)</span>
                <input
                  v-model="selectedTpl.naming.alias"
                  class="mf-input"
                  type="text"
                  placeholder="namespace"
                />
              </label>
            </div>
            <div class="naming-test">
              <label class="mf mf-wide">
                <span>test service name</span>
                <input
                  v-model="namingSample"
                  class="mf-input mono"
                  type="text"
                  spellcheck="false"
                  placeholder="songs.sample"
                />
              </label>
              <div class="naming-result" :class="{ ok: namingTest.ok, err: !namingTest.ok }">
                <div v-if="namingTest.error" class="naming-error">
                  <span class="naming-tag">error</span>
                  <span>{{ namingTest.error }}</span>
                </div>
                <template v-else>
                  <div class="naming-result-row">
                    <span class="naming-tag">display</span>
                    <span class="mono">{{ namingTest.display ?? '—' }}</span>
                  </div>
                  <div class="naming-result-row">
                    <span class="naming-tag">{{ namingTest.alias ?? 'group' }}</span>
                    <span class="mono accent">{{ namingTest.group ?? '—' }}</span>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </section>

        <!-- Topology + API dependency config editor — node + line
             metric definitions, with optional 4-band thresholds.
             Each metric edits id / label / MQE / unit / role /
             aggregation; thresholds are a collapsible block. -->
        <TopologyConfigEditor
          v-if="activeScope === 'topology'"
          v-model:config="selectedTpl.topology"
          :service-noun="serviceNoun"
          :instance-noun="instanceNoun"
        />

        <DeploymentConfigEditor
          v-else-if="activeScope === 'deployment'"
          v-model:config="selectedTpl.deployment"
          :instance-noun="instanceNoun"
        />

        <DependencyConfigSection
          v-else-if="activeScope === 'dependency'"
          v-model:config="selectedTpl.endpointDependency"
        />

        <ProcessConfigEditor
          v-else-if="activeScope === 'networkProfiling'"
          v-model:config="selectedTpl.processTopology"
        />

        <!-- Trace + Logs are built-in views with no per-layer config
             other than enable/disable, which is already handled via
             the Components toggle in the right sidebar. -->
        <section
          v-else-if="activeScopeRuntimeOnly"
          class="sw-card editor-card topo-cfg-card"
        >
          <div class="card-head">
            <h4>{{ scopeLabel(activeScope) }} tab</h4>
            <span class="sub">
              {{ activeScope === 'trace'
                ? 'Pick the trace backend this layer reads from.'
                : 'No per-layer config required — toggle visibility via Components in the right sidebar.' }}
            </span>
          </div>
          <div class="topo-cfg-body">
            <div v-if="activeScope === 'trace'" class="trace-source-cfg">
              <div class="trace-source-head">Trace source</div>
              <div class="trace-source-opts">
                <label
                  v-for="o in TRACE_SOURCE_OPTIONS"
                  :key="o.value"
                  class="trace-source-opt"
                  :class="{ on: traceSource === o.value }"
                >
                  <input
                    type="radio"
                    name="trace-source"
                    :value="o.value"
                    :checked="traceSource === o.value"
                    @change="traceSource = o.value"
                  />
                  <span class="ts-label">{{ o.label }}</span>
                  <span class="ts-hint">{{ o.hint }}</span>
                </label>
              </div>
            </div>
            <p v-else class="topo-cfg-help">
              The <b>{{ scopeLabel(activeScope) }}</b> tab is a built-in view that uses
              SkyWalking-native query-protocol APIs directly. Operators configure filters
              and time range at runtime from the page itself; nothing to wire up here.
            </p>
          </div>
        </section>

        <WidgetEditorCanvas
          v-else
          :draft="draft"
          :active-scope="activeScope"
        />
      </main>

    </div>

    <!-- Push confirm: shows the remote → local diff before publishing. -->
    <Modal :open="pushDiffOpen" title="Publish local → OAP?" width="min(1100px, 94vw)" @close="pushDiffOpen = false">
      <p class="push-lede">
        This replaces the live (remote) version with your local draft — live for everyone. Review the
        diff (left = remote, right = your local):
      </p>
      <div class="push-diff">
        <MonacoDiff :original="pushRemotePretty" :modified="pushLocalPretty" language="json" />
      </div>
      <template #footer>
        <button class="sw-btn" type="button" @click="pushDiffOpen = false">Cancel</button>
        <button class="sw-btn is-primary" type="button" :disabled="isSaving" @click="pushToOap">
          {{ isSaving ? 'Pushing…' : 'Confirm push' }}
        </button>
      </template>
    </Modal>

    <!-- Disable / delete / reactivate confirm — styled (not native). -->
    <Modal :open="deleteOpen" :title="confirmTitle" width="min(520px, 92vw)" @close="deleteOpen = false">
      <p class="confirm-msg">{{ confirmMessage }}</p>
      <template #footer>
        <button class="sw-btn" type="button" @click="deleteOpen = false">Cancel</button>
        <button class="sw-btn" :class="{ danger: confirmIsDanger, 'is-primary': !confirmIsDanger }" type="button" :disabled="isSaving" @click="runConfirm">
          {{ confirmLabel }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.admin-page {
  padding: 20px 20px 60px;
  max-width: 1440px;
  margin: 0 auto;
}
.page-head { margin-bottom: 18px; }
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  margin-bottom: 6px;
}
.page-head h1 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.lede {
  font-size: 12.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 720px;
}
.banner.err {
  padding: 8px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 12px;
  margin-bottom: 14px;
}
.empty {
  padding: 32px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}
.grid {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 14px;
  align-items: start;
  transition: grid-template-columns 160ms ease;
}
.grid.list-collapsed {
  grid-template-columns: 1fr;
}
.detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.chip {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
}
.chip.on {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
}
.push-lede { margin: 0 0 10px; font-size: 12px; color: var(--sw-fg-2); line-height: 1.5; }
.confirm-msg { margin: 0; font-size: 13px; line-height: 1.55; color: var(--sw-fg-1); }
.push-diff { height: 50vh; min-height: 320px; border: 1px solid var(--sw-line); border-radius: 6px; overflow: hidden; }

.components-card { padding: 0; }
.components-card .card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.components-card .card-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.components-card .card-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.naming-flags-hint {
  margin: -4px 0 4px;
  font-size: 11px;
  color: var(--sw-fg-3);
  padding: 0 4px;
}
.naming-flags-hint code {
  font-family: var(--sw-mono);
  background: var(--sw-bg-2);
  padding: 1px 4px;
  border-radius: 3px;
  color: var(--sw-fg-1);
}
/* Service-naming rule editor — pattern + capture mapping + live test. */
.naming-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
}
.naming-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.naming-row .mf {
  flex: 1 1 160px;
}
.naming-test {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  margin-top: 6px;
  padding-top: 10px;
  border-top: 1px dashed var(--sw-line);
}
.naming-result {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  font-size: 11.5px;
  flex: 1 1 280px;
}
.naming-result.ok { border-color: var(--sw-accent-line); }
.naming-result.err { border-color: var(--sw-err); background: rgba(239, 68, 68, 0.06); }
.naming-result-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.naming-tag {
  font-size: 9.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  padding: 1px 6px;
  border-radius: 4px;
}
.naming-result .mono { font-family: var(--sw-mono); color: var(--sw-fg-0); font-weight: 600; }
.naming-result .mono.accent { color: var(--sw-accent-2); }
.naming-error {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  color: var(--sw-err);
}

/* overflow: visible overrides .sw-card's `overflow: hidden`, which would
 * otherwise clip the sticky header inside the card (so it wouldn't pin). */
.editor-card { padding: 0; overflow: visible; }
/* Topology / endpoint-dep config preview — read-only JSON view. */
.topo-cfg-body { padding: 12px 14px 16px; }
.topo-cfg-help {
  margin: 0 0 10px;
  font-size: 11.5px;
  color: var(--sw-fg-3);
  line-height: 1.5;
}
.trace-source-cfg { display: flex; flex-direction: column; gap: 8px; }
.trace-source-head {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
}
.trace-source-opts { display: flex; flex-direction: column; gap: 6px; }
.trace-source-opt {
  display: grid;
  grid-template-columns: 16px 64px 1fr;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  background: var(--sw-bg-1);
  cursor: pointer;
  font-size: 11.5px;
}
.trace-source-opt.on { border-color: var(--sw-accent); background: var(--sw-bg-2); }
.trace-source-opt .ts-label { font-weight: 600; color: var(--sw-fg-0); }
.trace-source-opt .ts-hint { color: var(--sw-fg-3); }
.topo-cfg-help code {
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
/* Topology / endpoint-dep form editor */
.topo-cfg-card .topo-cfg-body { padding: 4px 0 0; }
.mf {
  display: inline-flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10px;
  color: var(--sw-fg-3);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  min-width: 110px;
}
.mf.mf-wide { min-width: 220px; flex: 1; }
.mf.mf-narrow { min-width: 80px; }
.mf-input {
  height: 26px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
  width: 100%;
  box-sizing: border-box;
}
.mf-input.mono { font-family: var(--sw-mono); }
.sw-btn.small.ghost {
  background: transparent;
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
  border-radius: 3px;
  cursor: pointer;
}
.sw-btn.small.ghost.danger { color: var(--sw-err); border-color: rgba(239, 68, 68, 0.3); }
.sw-btn.small.ghost[disabled] { opacity: 0.4; cursor: not-allowed; }
.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--sw-line);
}
.card-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
  text-transform: capitalize;
}
.card-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.card-head .add {
  margin-left: auto;
  font-size: 11.5px;
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  border-color: var(--sw-accent-line);
}
.sw-btn.danger {
  border-color: rgba(239, 68, 68, 0.3);
  color: #f87171;
}
.sw-btn.danger:hover {
  background: var(--sw-err-soft);
}
</style>
