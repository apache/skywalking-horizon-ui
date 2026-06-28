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
  Deployment config editor — the deployment topology of all of a service's
  instances: per-instance node metrics + per-side edge metrics
  (ServiceInstance / ServiceInstanceRelation scope), plus the three independent
  grouping rules (clusterBy → dashed boxes, siblingBy → pod bundling,
  roleBy + roles[] → container role classification) and per-(role → role) edge
  metric sets. Config-local: owns the `deployment` block via v-model.

  PRESENCE-only gate: the block's existence flips caps.deployment on save, so it
  must never materialize from a render-time read — only from an explicit operator
  edit. The metric lists are therefore read straight off config.value (a missing
  block reads as empty detached lists) and only ensure()'d into being on an add /
  rule edit — never on mount/render, so a mere Deployment-tab visit leaves the
  draft untouched (no phantom dirty; the legacy code read deployment straight too).
-->
<script setup lang="ts">
import { computed, reactive } from 'vue';
import type {
  ClusterByRule,
  DeploymentConfig,
  DeploymentMetricDef,
  NodeRoleConfig,
  RolePairMetrics,
} from '@skywalking-horizon-ui/api-client';
import { TOPOLOGY_ROLE_OPTIONS } from './layer-dashboards.scopes';
import MetricDefinitionRow from './MetricDefinitionRow.vue';
import RoleMetricRow from './RoleMetricRow.vue';
import { rowKey } from './row-key';

const config = defineModel<DeploymentConfig | undefined>('config');
defineProps<{ instanceNoun: string }>();

// Write-path accessor for the `deployment` block. The block's PRESENCE is what
// flips caps.deployment on save (the menu gate is presence-only), so it must
// never materialize from a render-time read — only from an explicit operator
// edit. Targeted per-list creation also keeps a roles-first config (which
// deliberately omits top-level nodeMetrics) untouched by edits to the other
// lists.
function ensure(): DeploymentConfig {
  if (!config.value) config.value = {};
  return config.value;
}
function ensureDeploymentList(
  bucket: 'sitNode' | 'sitLinkServer' | 'sitLinkClient',
): DeploymentMetricDef[] {
  const t = ensure();
  const key =
    bucket === 'sitNode' ? 'nodeMetrics'
    : bucket === 'sitLinkServer' ? 'linkServerMetrics'
    : 'linkClientMetrics';
  if (!t[key]) t[key] = [];
  return t[key];
}

// Read straight off the block — never auto-create it on render (see ensure);
// a missing block reads as empty detached lists.
const deploymentNodeMetrics = computed<DeploymentMetricDef[]>(() => config.value?.nodeMetrics ?? []);
const deploymentServerMetrics = computed<DeploymentMetricDef[]>(() => config.value?.linkServerMetrics ?? []);
const deploymentClientMetrics = computed<DeploymentMetricDef[]>(() => config.value?.linkClientMetrics ?? []);

function getSitList(bucket: 'sitNode' | 'sitLinkServer' | 'sitLinkClient'): DeploymentMetricDef[] {
  const t = config.value;
  if (bucket === 'sitNode') return t?.nodeMetrics ?? [];
  if (bucket === 'sitLinkServer') return t?.linkServerMetrics ?? [];
  return t?.linkClientMetrics ?? [];
}
function addMetric(bucket: 'sitNode' | 'sitLinkServer' | 'sitLinkClient'): void {
  const list = ensureDeploymentList(bucket);
  list.push({
    id: `metric_${list.length + 1}`,
    label: `Metric ${list.length + 1}`,
    mqe: '',
    unit: '',
    aggregation: 'avg',
  });
}
function removeMetric(bucket: 'sitNode' | 'sitLinkServer' | 'sitLinkClient', i: number): void {
  getSitList(bucket).splice(i, 1);
}
function moveMetric(bucket: 'sitNode' | 'sitLinkServer' | 'sitLinkClient', i: number, dir: -1 | 1): void {
  const list = getSitList(bucket);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

// clusterBy editor — four modes: off / by one instance attribute / by several
// attributes (composite key) / by name regex. Reads + writes
// `deployment.clusterBy`; switching mode reshapes the
// discriminated union.
type ClusterMode = 'none' | 'attribute' | 'attributes' | 'nameRegex';
const sitClusterMode = computed<ClusterMode>({
  get: () => {
    const cb = config.value?.clusterBy;
    return cb?.kind ?? 'none';
  },
  set: (mode) => {
    const t = ensure();
    if (mode === 'none') {
      delete t.clusterBy;
    } else if (mode === 'attribute') {
      const prev = t.clusterBy;
      t.clusterBy = {
        kind: 'attribute',
        attribute: prev?.kind === 'attribute' ? prev.attribute : 'node_role',
        alias: prev?.alias ?? 'role',
      };
    } else if (mode === 'attributes') {
      const prev = t.clusterBy;
      t.clusterBy = {
        kind: 'attributes',
        attributes: prev?.kind === 'attributes' ? prev.attributes : ['node_role', 'node_type'],
        separator: prev?.kind === 'attributes' ? prev.separator : undefined,
        alias: prev?.alias ?? 'role',
      };
    } else {
      const prev = t.clusterBy;
      t.clusterBy = {
        kind: 'nameRegex',
        pattern: prev?.kind === 'nameRegex' ? prev.pattern : '',
        flags: prev?.kind === 'nameRegex' ? prev.flags : undefined,
        displayGroup: prev?.kind === 'nameRegex' ? prev.displayGroup : undefined,
        valueGroup: prev?.kind === 'nameRegex' ? prev.valueGroup : undefined,
        alias: prev?.alias ?? 'group',
      };
    }
  },
});
function clusterRuleField<K extends keyof Extract<ClusterByRule, { kind: 'nameRegex' }>>(
  field: K,
  kind: ClusterByRule['kind'],
) {
  return computed<string>({
    get: () => {
      const cb = config.value?.clusterBy;
      if (!cb || cb.kind !== kind) return '';
      return (cb as Record<string, unknown>)[field as string] as string ?? '';
    },
    set: (v) => {
      const cb = ensure().clusterBy;
      if (cb && cb.kind === kind) {
        (cb as Record<string, unknown>)[field as string] = v || undefined;
      }
    },
  });
}
const sitClusterAttribute = computed<string>({
  get: () => {
    const cb = config.value?.clusterBy;
    return cb?.kind === 'attribute' ? cb.attribute : '';
  },
  set: (v) => {
    const cb = ensure().clusterBy;
    if (cb?.kind === 'attribute') cb.attribute = v;
  },
});
// Composite mode — comma-separated attribute list (order = key order).
const sitClusterAttributes = computed<string>({
  get: () => {
    const cb = config.value?.clusterBy;
    return cb?.kind === 'attributes' ? cb.attributes.join(', ') : '';
  },
  set: (v) => {
    const cb = ensure().clusterBy;
    if (cb?.kind === 'attributes') {
      cb.attributes = v.split(',').map((s) => s.trim()).filter(Boolean);
    }
  },
});
// Composite mode — joiner between present attribute values (default ` / `).
const sitClusterSeparator = computed<string>({
  get: () => {
    const cb = config.value?.clusterBy;
    return cb?.kind === 'attributes' ? (cb.separator ?? '') : '';
  },
  set: (v) => {
    const cb = ensure().clusterBy;
    if (cb?.kind === 'attributes') cb.separator = v || undefined;
  },
});
const sitClusterAlias = computed<string>({
  get: () => config.value?.clusterBy?.alias ?? '',
  set: (v) => {
    const cb = ensure().clusterBy;
    if (cb) cb.alias = v;
  },
});
const sitClusterPattern = clusterRuleField('pattern', 'nameRegex');
const sitClusterFlags = clusterRuleField('flags', 'nameRegex');
const sitClusterDisplayGroup = clusterRuleField('displayGroup', 'nameRegex');
const sitClusterValueGroup = clusterRuleField('valueGroup', 'nameRegex');

// Generic editor for a deployment grouping rule (a `ClusterByRule`). `siblingBy`
// and `roleBy` share clusterBy's four-mode shape, so rather than duplicate the
// dozen computeds we bind a fresh editor to each field via read/write closures
// and expose it as a reactive bag of v-model targets (reactive() unwraps the
// nested computeds so the template can use `siblingEd.mode` etc. directly).
function makeRuleEditor(
  read: () => ClusterByRule | undefined,
  write: (r: ClusterByRule | undefined) => void,
  fb: { attribute: string; attributes: string[]; alias: string },
) {
  const regexField = (name: 'pattern' | 'flags' | 'displayGroup' | 'valueGroup') =>
    computed<string>({
      get: () => {
        const r = read();
        return r?.kind === 'nameRegex' ? ((r as Record<string, unknown>)[name] as string) ?? '' : '';
      },
      set: (v) => {
        const r = read();
        if (r?.kind === 'nameRegex') (r as Record<string, unknown>)[name] = v || undefined;
      },
    });
  return reactive({
    mode: computed<ClusterMode>({
      get: () => read()?.kind ?? 'none',
      set: (m) => {
        const prev = read();
        if (m === 'none') return write(undefined);
        if (m === 'attribute')
          return write({ kind: 'attribute', attribute: prev?.kind === 'attribute' ? prev.attribute : fb.attribute, alias: prev?.alias ?? fb.alias });
        if (m === 'attributes')
          return write({ kind: 'attributes', attributes: prev?.kind === 'attributes' ? prev.attributes : [...fb.attributes], separator: prev?.kind === 'attributes' ? prev.separator : undefined, alias: prev?.alias ?? fb.alias });
        return write({ kind: 'nameRegex', pattern: prev?.kind === 'nameRegex' ? prev.pattern : '', flags: prev?.kind === 'nameRegex' ? prev.flags : undefined, displayGroup: prev?.kind === 'nameRegex' ? prev.displayGroup : undefined, valueGroup: prev?.kind === 'nameRegex' ? prev.valueGroup : undefined, alias: prev?.alias ?? fb.alias });
      },
    }),
    attribute: computed<string>({
      get: () => { const r = read(); return r?.kind === 'attribute' ? r.attribute : ''; },
      set: (v) => { const r = read(); if (r?.kind === 'attribute') r.attribute = v; },
    }),
    attributes: computed<string>({
      get: () => { const r = read(); return r?.kind === 'attributes' ? r.attributes.join(', ') : ''; },
      set: (v) => { const r = read(); if (r?.kind === 'attributes') r.attributes = v.split(',').map((s) => s.trim()).filter(Boolean); },
    }),
    separator: computed<string>({
      get: () => { const r = read(); return r?.kind === 'attributes' ? (r.separator ?? '') : ''; },
      set: (v) => { const r = read(); if (r?.kind === 'attributes') r.separator = v || undefined; },
    }),
    alias: computed<string>({
      get: () => read()?.alias ?? '',
      set: (v) => { const r = read(); if (r) r.alias = v; },
    }),
    pattern: regexField('pattern'),
    flags: regexField('flags'),
    displayGroup: regexField('displayGroup'),
    valueGroup: regexField('valueGroup'),
  });
}
const siblingEd = makeRuleEditor(
  () => config.value?.siblingBy,
  (r) => { const t = ensure(); if (r === undefined) delete t.siblingBy; else t.siblingBy = r; },
  { attribute: 'pod_name', attributes: ['pod_name'], alias: 'pod' },
);
const roleEd = makeRuleEditor(
  () => config.value?.roleBy,
  (r) => { const t = ensure(); if (r === undefined) delete t.roleBy; else t.roleBy = r; },
  { attribute: 'container_name', attributes: ['container_name'], alias: 'container' },
);

// roleBy → roles[]: per-role metric sets. A node shows its role's metrics
// (matched on the roleBy value), falling back to the top-level node metrics.
const deploymentRoles = computed<NodeRoleConfig[]>(() => config.value?.roles ?? []);
function addRole(): void {
  const t = ensure();
  if (!t.roles) t.roles = [];
  t.roles.push({ key: `role_${t.roles.length + 1}`, label: '', main: false, nodeMetrics: [] });
}
function removeRole(i: number): void {
  config.value?.roles?.splice(i, 1);
}
function moveRole(i: number, dir: -1 | 1): void {
  const list = config.value?.roles;
  if (!list) return;
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}
function ensureRoleMetrics(r: NodeRoleConfig): DeploymentMetricDef[] {
  if (!r.nodeMetrics) r.nodeMetrics = [];
  return r.nodeMetrics;
}
function addRoleMetric(list: DeploymentMetricDef[]): void {
  list.push({ id: `metric_${list.length + 1}`, label: `Metric ${list.length + 1}`, mqe: '', unit: '', aggregation: 'avg' });
}
function removeRoleMetric(list: DeploymentMetricDef[], i: number): void {
  list.splice(i, 1);
}
function moveRoleMetric(list: DeploymentMetricDef[], i: number, dir: -1 | 1): void {
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

// roleToRole[]: per source→target role-pair edge metrics. Pair scaffolding only —
// the per-metric rows reuse addRoleMetric / moveRoleMetric / removeRoleMetric.
const deploymentRoleToRole = computed<RolePairMetrics[]>(() => config.value?.roleToRole ?? []);
function addRolePair(): void {
  const t = ensure();
  if (!t.roleToRole) t.roleToRole = [];
  t.roleToRole.push({ from: '*', to: '*', primary: '', metrics: [] });
}
function removeRolePair(i: number): void {
  config.value?.roleToRole?.splice(i, 1);
}
function moveRolePair(i: number, dir: -1 | 1): void {
  const list = config.value?.roleToRole;
  if (!list) return;
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}
function ensurePairMetrics(p: RolePairMetrics): DeploymentMetricDef[] {
  if (!p.metrics) p.metrics = [];
  return p.metrics;
}
// `primary` is up to 3 metric ids printed on the edge — edited as a comma list,
// stored as a single string (1) or array (2-3), capped at 3.
function primaryStr(p: RolePairMetrics): string {
  return Array.isArray(p.primary) ? p.primary.join(', ') : p.primary ?? '';
}
function setPrimary(p: RolePairMetrics, v: string): void {
  const ids = v.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3);
  if (ids.length === 0) delete p.primary;
  else if (ids.length === 1) p.primary = ids[0];
  else p.primary = ids;
}
</script>

<template>
  <!-- Deployment config — instance node + per-side edge metrics
       (ServiceInstance / ServiceInstanceRelation scope) plus the optional
       node-clustering rule. Independent of the service-map topology block. -->
  <section class="sw-card editor-card topo-cfg-card">
    <div class="card-head">
      <h4>Deployment config</h4>
      <span class="sub">deployment topology of all the service’s instances. node = {{ instanceNoun }} · edges = intra-service instance relations.</span>
    </div>
    <div class="topo-cfg-body">
      <!-- Node clustering: group instance nodes into boxes either by an
           instance attribute (node_role / node_type) or by a name regex
           run on the instance name. -->
      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>Node clustering</h5>
          <span class="sub">group instances into dashed boxes — off, by a single attribute, by several attributes (composite key + separator), or by a name regex (e.g. <code>node_role</code> + <code>node_type</code>)</span>
        </header>
        <div class="sit-cluster-cfg">
          <label class="mf mf-narrow">
            <span>mode</span>
            <select v-model="sitClusterMode" class="mf-input">
              <option value="none">none</option>
              <option value="attribute">by attribute</option>
              <option value="attributes">by attributes (composite)</option>
              <option value="nameRegex">by name regex</option>
            </select>
          </label>
          <template v-if="sitClusterMode === 'attribute'">
            <label class="mf"><span>attribute</span><input v-model="sitClusterAttribute" type="text" class="mf-input mono" placeholder="node_role" /></label>
            <label class="mf"><span>alias</span><input v-model="sitClusterAlias" type="text" class="mf-input" placeholder="role" /></label>
          </template>
          <template v-else-if="sitClusterMode === 'attributes'">
            <label class="mf mf-wide"><span>attributes</span><input v-model="sitClusterAttributes" type="text" class="mf-input mono" placeholder="node_role, node_type" /></label>
            <label class="mf mf-narrow"><span>separator</span><input v-model="sitClusterSeparator" type="text" class="mf-input mono" placeholder=" / " /></label>
            <label class="mf"><span>alias</span><input v-model="sitClusterAlias" type="text" class="mf-input" placeholder="role" /></label>
          </template>
          <template v-else-if="sitClusterMode === 'nameRegex'">
            <label class="mf mf-wide"><span>pattern</span><input v-model="sitClusterPattern" type="text" class="mf-input mono" placeholder="^(?<service>.+?)-(?<group>data|liaison)" /></label>
            <label class="mf mf-narrow"><span>flags</span><input v-model="sitClusterFlags" type="text" class="mf-input mono" placeholder="i" /></label>
            <label class="mf mf-narrow"><span>display grp</span><input v-model="sitClusterDisplayGroup" type="text" class="mf-input mono" placeholder="service" /></label>
            <label class="mf mf-narrow"><span>value grp</span><input v-model="sitClusterValueGroup" type="text" class="mf-input mono" placeholder="group" /></label>
            <label class="mf"><span>alias</span><input v-model="sitClusterAlias" type="text" class="mf-input" placeholder="group" /></label>
          </template>
        </div>
      </div>

      <!-- siblingBy: which containers bundle into ONE pod hex. -->
      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>Sibling grouping</h5>
          <span class="sub">bundle related instances into ONE hex group — instances sharing this key render together as one main + attached siblings (e.g. the containers of one Kubernetes pod, keyed by <code>pod_name</code>). Single attribute, several attributes (composite key + separator), or a name regex. Off ⇒ every instance is its own hex.</span>
        </header>
        <div class="sit-cluster-cfg">
          <label class="mf mf-narrow"><span>mode</span>
            <select v-model="siblingEd.mode" class="mf-input">
              <option value="none">none</option>
              <option value="attribute">by attribute</option>
              <option value="attributes">by attributes (composite)</option>
              <option value="nameRegex">by name regex</option>
            </select>
          </label>
          <template v-if="siblingEd.mode === 'attribute'">
            <label class="mf"><span>attribute</span><input v-model="siblingEd.attribute" type="text" class="mf-input mono" placeholder="pod_name" /></label>
            <label class="mf"><span>alias</span><input v-model="siblingEd.alias" type="text" class="mf-input" placeholder="pod" /></label>
          </template>
          <template v-else-if="siblingEd.mode === 'attributes'">
            <label class="mf mf-wide"><span>attributes</span><input v-model="siblingEd.attributes" type="text" class="mf-input mono" placeholder="pod_name" /></label>
            <label class="mf mf-narrow"><span>separator</span><input v-model="siblingEd.separator" type="text" class="mf-input mono" placeholder=" / " /></label>
            <label class="mf"><span>alias</span><input v-model="siblingEd.alias" type="text" class="mf-input" placeholder="pod" /></label>
          </template>
          <template v-else-if="siblingEd.mode === 'nameRegex'">
            <label class="mf mf-wide"><span>pattern</span><input v-model="siblingEd.pattern" type="text" class="mf-input mono" /></label>
            <label class="mf mf-narrow"><span>flags</span><input v-model="siblingEd.flags" type="text" class="mf-input mono" placeholder="i" /></label>
            <label class="mf mf-narrow"><span>display grp</span><input v-model="siblingEd.displayGroup" type="text" class="mf-input mono" /></label>
            <label class="mf mf-narrow"><span>value grp</span><input v-model="siblingEd.valueGroup" type="text" class="mf-input mono" /></label>
            <label class="mf"><span>alias</span><input v-model="siblingEd.alias" type="text" class="mf-input" placeholder="pod" /></label>
          </template>
        </div>
      </div>

      <!-- roleBy: classify each container; picks the main hex + per-role metrics. -->
      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>Node role</h5>
          <span class="sub">classify each instance by a role — picks the MAIN hex of a sibling group and which role's metric set (below) applies (e.g. <code>container_name</code> → liaison / data / lifecycle). Single attribute, several attributes (composite key + separator), or a name regex.</span>
        </header>
        <div class="sit-cluster-cfg">
          <label class="mf mf-narrow"><span>mode</span>
            <select v-model="roleEd.mode" class="mf-input">
              <option value="none">none</option>
              <option value="attribute">by attribute</option>
              <option value="attributes">by attributes (composite)</option>
              <option value="nameRegex">by name regex</option>
            </select>
          </label>
          <template v-if="roleEd.mode === 'attribute'">
            <label class="mf"><span>attribute</span><input v-model="roleEd.attribute" type="text" class="mf-input mono" placeholder="container_name" /></label>
            <label class="mf"><span>alias</span><input v-model="roleEd.alias" type="text" class="mf-input" placeholder="container" /></label>
          </template>
          <template v-else-if="roleEd.mode === 'attributes'">
            <label class="mf mf-wide"><span>attributes</span><input v-model="roleEd.attributes" type="text" class="mf-input mono" placeholder="container_name" /></label>
            <label class="mf mf-narrow"><span>separator</span><input v-model="roleEd.separator" type="text" class="mf-input mono" placeholder=" / " /></label>
            <label class="mf"><span>alias</span><input v-model="roleEd.alias" type="text" class="mf-input" placeholder="container" /></label>
          </template>
          <template v-else-if="roleEd.mode === 'nameRegex'">
            <label class="mf mf-wide"><span>pattern</span><input v-model="roleEd.pattern" type="text" class="mf-input mono" /></label>
            <label class="mf mf-narrow"><span>flags</span><input v-model="roleEd.flags" type="text" class="mf-input mono" placeholder="i" /></label>
            <label class="mf mf-narrow"><span>display grp</span><input v-model="roleEd.displayGroup" type="text" class="mf-input mono" /></label>
            <label class="mf mf-narrow"><span>value grp</span><input v-model="roleEd.valueGroup" type="text" class="mf-input mono" /></label>
            <label class="mf"><span>alias</span><input v-model="roleEd.alias" type="text" class="mf-input" placeholder="container" /></label>
          </template>
        </div>
      </div>

      <!-- roles[]: per-role metric sets keyed by the Container-role value. -->
      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>Roles</h5>
          <span class="sub">per-role metric sets — an instance renders the metrics of its role (matched on the “Node role” value above); a role with no metrics falls back to the node metrics below</span>
          <button class="sw-btn add" type="button" @click="addRole">＋ Add role</button>
        </header>
        <div v-if="deploymentRoles.length === 0" class="topo-cfg-empty">No roles defined. Add one per role (e.g. liaison / data / lifecycle) to give each its own metrics.</div>
        <div v-else class="role-list">
          <article v-for="(r, ri) in deploymentRoles" :key="rowKey(r)" class="role-card">
            <div class="role-head">
              <label class="mf mf-narrow"><span>key</span><input v-model="r.key" type="text" class="mf-input mono" placeholder="liaison" /></label>
              <label class="mf"><span>label</span><input v-model="r.label" type="text" class="mf-input" placeholder="Liaison" /></label>
              <label class="mf mf-checkbox"><input v-model="r.main" type="checkbox" /><span>main hex</span></label>
              <div class="metric-row-actions">
                <button class="sw-btn small ghost" type="button" :disabled="ri === 0" title="Move up" @click="moveRole(ri, -1)">↑</button>
                <button class="sw-btn small ghost" type="button" :disabled="ri === deploymentRoles.length - 1" title="Move down" @click="moveRole(ri, 1)">↓</button>
                <button class="sw-btn small ghost danger" type="button" title="Remove role" @click="removeRole(ri)">×</button>
              </div>
            </div>
            <div class="role-metrics">
              <header class="topo-cfg-head role-metrics-head">
                <h6>metrics for “{{ r.label || r.key || 'role' }}” — queried as <code>service_instance_*</code></h6>
                <button class="sw-btn add" type="button" @click="addRoleMetric(ensureRoleMetrics(r))">＋ Add</button>
              </header>
              <div v-if="!r.nodeMetrics || r.nodeMetrics.length === 0" class="topo-cfg-empty">No metrics — this role falls back to the node metrics below.</div>
              <div v-else class="metric-list">
                <RoleMetricRow
                  v-for="(m, mi) in r.nodeMetrics"
                  :key="rowKey(m)"
                  v-model:metric="r.nodeMetrics[mi]"
                  :role-options="TOPOLOGY_ROLE_OPTIONS"
                  show-role
                  show-thresholds
                  mqe-placeholder="service_instance_cpm"
                  mqe-title="Node MQE"
                  unit-placeholder="rpm"
                  :can-move-up="mi > 0"
                  :can-move-down="mi < r.nodeMetrics.length - 1"
                  @move-up="moveRoleMetric(r.nodeMetrics!, mi, -1)"
                  @move-down="moveRoleMetric(r.nodeMetrics!, mi, 1)"
                  @remove="removeRoleMetric(r.nodeMetrics!, mi)"
                />
              </div>
            </div>
          </article>
        </div>
      </div>

      <!-- roleToRole[]: per source→target role-pair edge metrics (takes precedence over the link fallback below). -->
      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>Role-to-role edge metrics</h5>
          <span class="sub">per source→target role-pair edge metrics (e.g. liaison → data) — takes precedence over the link fallback below; <code>from</code>/<code>to</code> use role keys or <code>*</code> for any</span>
          <button class="sw-btn add" type="button" @click="addRolePair">＋ Add pair</button>
        </header>
        <div v-if="deploymentRoleToRole.length === 0" class="topo-cfg-empty">No role pairs. Add one per edge type (e.g. liaison → data); otherwise edges use the link fallback below.</div>
        <div v-else class="role-list">
          <article v-for="(p, pi) in deploymentRoleToRole" :key="rowKey(p)" class="role-card">
            <div class="role-head">
              <label class="mf mf-narrow"><span>from</span><input v-model="p.from" type="text" class="mf-input mono" placeholder="liaison" /></label>
              <label class="mf mf-narrow"><span>to</span><input v-model="p.to" type="text" class="mf-input mono" placeholder="data" /></label>
              <label class="mf"><span>primary (≤3)</span><input :value="primaryStr(p)" type="text" class="mf-input mono" placeholder="write, query" title="Up to 3 metric ids, comma-separated — printed on the edge" @input="setPrimary(p, ($event.target as HTMLInputElement).value)" /></label>
              <div class="metric-row-actions">
                <button class="sw-btn small ghost" type="button" :disabled="pi === 0" title="Move up" @click="moveRolePair(pi, -1)">↑</button>
                <button class="sw-btn small ghost" type="button" :disabled="pi === deploymentRoleToRole.length - 1" title="Move down" @click="moveRolePair(pi, 1)">↓</button>
                <button class="sw-btn small ghost danger" type="button" title="Remove pair" @click="removeRolePair(pi)">×</button>
              </div>
            </div>
            <div class="role-metrics">
              <header class="topo-cfg-head role-metrics-head">
                <h6>edge metrics for “{{ p.from || '*' }} → {{ p.to || '*' }}” — queried as <code>service_instance_relation_*</code></h6>
                <button class="sw-btn add" type="button" @click="addRoleMetric(ensurePairMetrics(p))">＋ Add</button>
              </header>
              <div v-if="!p.metrics || p.metrics.length === 0" class="topo-cfg-empty">No metrics — this edge falls back to the link metrics below.</div>
              <div v-else class="metric-list">
                <RoleMetricRow
                  v-for="(m, mi) in p.metrics"
                  :key="rowKey(m)"
                  v-model:metric="p.metrics[mi]"
                  :role-options="TOPOLOGY_ROLE_OPTIONS"
                  show-role
                  show-alias
                  mqe-placeholder="service_instance_relation_client_cpm"
                  mqe-title="Edge MQE"
                  unit-placeholder="ms"
                  :can-move-up="mi > 0"
                  :can-move-down="mi < p.metrics.length - 1"
                  @move-up="moveRoleMetric(p.metrics, mi, -1)"
                  @move-down="moveRoleMetric(p.metrics, mi, 1)"
                  @remove="removeRoleMetric(p.metrics, mi)"
                />
              </div>
            </div>
          </article>
        </div>
      </div>

      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>Fallback node metrics</h5>
          <span class="sub">used for unroled instances + roles with no metrics of their own — queried as <code>service_instance_*</code></span>
          <button class="sw-btn add" type="button" @click="addMetric('sitNode')">＋ Add</button>
        </header>
        <div v-if="deploymentNodeMetrics.length === 0" class="topo-cfg-empty">No node metrics. Click "+ Add" to start.</div>
        <div v-else class="metric-list">
          <MetricDefinitionRow
            v-for="(m, i) in deploymentNodeMetrics"
            :key="rowKey(m)"
            v-model:metric="deploymentNodeMetrics[i]"
            :role-options="TOPOLOGY_ROLE_OPTIONS"
            show-role
            show-thresholds
            mqe-placeholder="service_instance_cpm"
            unit-placeholder="rpm"
            :can-move-up="i > 0"
            :can-move-down="i < deploymentNodeMetrics.length - 1"
            @move-up="moveMetric('sitNode', i, -1)"
            @move-down="moveMetric('sitNode', i, 1)"
            @remove="removeMetric('sitNode', i)"
          />
        </div>
      </div>

      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>Link · server-side metrics</h5>
          <span class="sub">edge metrics queried as <code>service_instance_relation_server_*</code></span>
          <button class="sw-btn add" type="button" @click="addMetric('sitLinkServer')">＋ Add</button>
        </header>
        <div v-if="deploymentServerMetrics.length === 0" class="topo-cfg-empty">No server-side metrics.</div>
        <div v-else class="metric-list">
          <MetricDefinitionRow
            v-for="(m, i) in deploymentServerMetrics"
            :key="rowKey(m)"
            v-model:metric="deploymentServerMetrics[i]"
            :can-move-up="i > 0"
            :can-move-down="i < deploymentServerMetrics.length - 1"
            @move-up="moveMetric('sitLinkServer', i, -1)"
            @move-down="moveMetric('sitLinkServer', i, 1)"
            @remove="removeMetric('sitLinkServer', i)"
          />
        </div>
      </div>

      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>Link · client-side metrics</h5>
          <span class="sub">edge metrics queried as <code>service_instance_relation_client_*</code></span>
          <button class="sw-btn add" type="button" @click="addMetric('sitLinkClient')">＋ Add</button>
        </header>
        <div v-if="deploymentClientMetrics.length === 0" class="topo-cfg-empty">No client-side metrics.</div>
        <div v-else class="metric-list">
          <MetricDefinitionRow
            v-for="(m, i) in deploymentClientMetrics"
            :key="rowKey(m)"
            v-model:metric="deploymentClientMetrics[i]"
            :can-move-up="i > 0"
            :can-move-down="i < deploymentClientMetrics.length - 1"
            @move-up="moveMetric('sitLinkClient', i, -1)"
            @move-down="moveMetric('sitLinkClient', i, 1)"
            @remove="removeMetric('sitLinkClient', i)"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* config-editor chrome (duplicated scoped; .sw-card / .sw-btn are global) */
.editor-card { padding: 0; overflow: visible; }
.topo-cfg-card .topo-cfg-body { padding: 4px 0 0; }
.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--sw-line);
}
.card-head h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sw-fg-0); text-transform: capitalize; }
.card-head .sub { font-size: 10.5px; color: var(--sw-fg-3); }
.topo-cfg-body { padding: 12px 14px 16px; }
.topo-cfg-section { padding: 12px 16px; border-bottom: 1px solid var(--sw-line); }
.topo-cfg-section:last-child { border-bottom: none; }
.topo-cfg-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.topo-cfg-head h5 {
  margin: 0;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--sw-accent);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.topo-cfg-head .sub { font-size: 10.5px; color: var(--sw-fg-3); flex: 1; }
.topo-cfg-head .sub code { font-family: var(--sw-mono); color: var(--sw-fg-1); background: var(--sw-bg-2); padding: 0 4px; border-radius: 3px; }
.topo-cfg-head .sw-btn.add {
  background: var(--sw-accent);
  color: var(--sw-bg-0);
  border: none;
  height: 24px;
  padding: 0 10px;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
}
.topo-cfg-empty {
  font-size: 11.5px;
  color: var(--sw-fg-3);
  padding: 12px;
  text-align: center;
  background: var(--sw-bg-2);
  border-radius: 4px;
}
.metric-list { display: flex; flex-direction: column; gap: 8px; }
.sit-cluster-cfg { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
/* Container roles editor — each role is a card holding its own metric list. */
.role-list { display: flex; flex-direction: column; gap: 10px; }
.role-card { border: 1px solid var(--sw-line); border-radius: 6px; padding: 10px 12px; background: var(--sw-bg-0); }
.role-head { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.role-head .metric-row-actions { margin-left: auto; }
.role-metrics { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--sw-line); }
.role-metrics-head { margin-bottom: 6px; }
.role-metrics-head h6 { margin: 0; font-size: 11px; font-weight: 600; color: var(--sw-fg-2); }
.role-metrics-head h6 code { font-family: var(--sw-mono); color: var(--sw-fg-3); background: var(--sw-bg-1); padding: 0 4px; border-radius: 3px; }
.metric-row-actions {
  display: inline-flex;
  gap: 4px;
  margin-left: auto;
  align-self: flex-end;
}
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
.mf.mf-checkbox {
  flex-direction: row;
  align-items: center;
  text-transform: none;
  letter-spacing: 0;
  font-size: 10.5px;
  color: var(--sw-fg-2);
  min-width: auto;
}
.mf.mf-checkbox input { accent-color: var(--sw-accent); }
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
</style>
