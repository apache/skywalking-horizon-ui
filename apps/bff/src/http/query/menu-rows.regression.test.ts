/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Proof that centralising row resolution moved nothing an operator sees.
 *
 * Before this, four places decided a layer's rows independently: the
 * sidebar's `v-if` chain, `firstLayerTab`'s `if` chain, `isSingleFeatureLayer`,
 * and `LayerShell`'s scope-predicate map. The originals are transcribed
 * below as ORACLES and run against every bundled layer template alongside
 * `resolveLayerMenuRows`. A difference here means the refactor changed the
 * menu for a shipped layer.
 *
 * The oracles are frozen copies of deleted code. Do NOT "fix" one to match
 * a new expectation — if resolution is meant to change, the diff belongs in
 * the expected-difference lists at the bottom, where it is reviewable.
 */

import { describe, it, expect } from 'vitest';
import type { LayerCaps, LayerDef, LayerSlots } from '@skywalking-horizon-ui/api-client';
import {
  resolveLayerMenuRows,
  firstLayerMenuRow,
  isSingleFeatureLayer,
  DEFAULT_LAYER_ROW_ORDER,
} from '@skywalking-horizon-ui/api-client';
import { allLayerTemplates, type LayerTemplate } from '../../logic/layers/loader.js';
import { componentsSchema } from '../../logic/templates/bundled-schema.js';
import { capsForTemplate } from '../../logic/layers/caps.js';

type Legacy = { caps: LayerCaps; slots: LayerSlots; traces?: { source?: string } };

/** The sidebar's `v-if` chain, in template order (SidebarLayerChildren.vue). */
function oracleSidebarRows(L: Legacy): string[] {
  const rows: string[] = [];
  const hasInstances = L.caps.instances ?? Boolean(L.slots.instances);
  const hasEndpoints = L.caps.endpoints ?? Boolean(L.slots.endpoints);
  const hasTopology = Boolean(L.caps.serviceMap || L.caps.instanceTopology || L.caps.processTopology);
  if (L.caps.dashboards) rows.push('service');
  if (hasInstances) rows.push('instance');
  if (hasEndpoints) rows.push('endpoint');
  if (hasTopology) rows.push('topology');
  if (L.caps.deployment) rows.push('deployment');
  if (L.caps.endpointDependency) rows.push('dependency');
  if (L.caps.traces) rows.push('trace');
  if (L.caps.traces && L.traces?.source === 'both') rows.push('zipkin-trace');
  if (L.caps.logs) rows.push('logs');
  if (L.caps.browserErrors) rows.push('browser-errors');
  if (L.caps.podLogs) rows.push('pod-logs');
  if (L.caps.traceProfiling) rows.push('trace-profiling');
  if (L.caps.ebpfProfiling) rows.push('ebpf-profiling');
  if (L.caps.networkProfiling) rows.push('network-profiling');
  if (L.caps.continuousProfiling) rows.push('continuous-profiling');
  if (L.caps.pprofProfiling) rows.push('pprof');
  if (L.caps.asyncProfiling) rows.push('async-profiling');
  return rows;
}

/** `firstLayerTab`'s ordered `if` chain (useLayers.ts). Note its profiling
 *  tail ordering differs from the sidebar's — that disagreement is exactly
 *  what the assertions below pin down. */
function oracleFirstTab(L: Legacy): string {
  if (L.caps.dashboards) return 'service';
  if (L.caps.instances ?? Boolean(L.slots.instances)) return 'instance';
  if (L.caps.endpoints ?? Boolean(L.slots.endpoints)) return 'endpoint';
  if (L.caps.serviceMap || L.caps.instanceTopology || L.caps.processTopology) return 'topology';
  if (L.caps.deployment) return 'deployment';
  if (L.caps.endpointDependency) return 'dependency';
  if (L.caps.traces) return 'trace';
  if (L.caps.logs) return 'logs';
  if (L.caps.browserErrors) return 'browser-errors';
  if (L.caps.podLogs) return 'pod-logs';
  if (L.caps.traceProfiling) return 'trace-profiling';
  if (L.caps.ebpfProfiling) return 'ebpf-profiling';
  if (L.caps.networkProfiling) return 'network-profiling';
  if (L.caps.asyncProfiling) return 'async-profiling';
  if (L.caps.pprofProfiling) return 'pprof';
  if (L.caps.continuousProfiling) return 'continuous-profiling';
  return 'service';
}

/** `isSingleFeatureLayer` as it was — direct link vs accordion. */
function oracleSingleFeature(L: Legacy): boolean {
  const hasInstances = L.caps.instances ?? Boolean(L.slots.instances);
  const hasEndpoints = L.caps.endpoints ?? Boolean(L.slots.endpoints);
  if (hasInstances || hasEndpoints) return false;
  if (L.caps.serviceMap || L.caps.instanceTopology || L.caps.processTopology) return false;
  const c = L.caps;
  if (c.traces || c.logs || c.browserErrors || c.traceProfiling || c.ebpfProfiling || c.asyncProfiling || c.events) return false;
  if (c.endpointDependency || c.serviceMap || c.instanceTopology || c.processTopology || c.deployment) return false;
  return true;
}

/** Every bundled layer, with the caps the menu route would serve for it. */
function bundledLayers(): Array<{ key: string; legacy: Legacy; def: LayerDef }> {
  return allLayerTemplates().map((tpl) => {
    const caps = capsForTemplate(tpl, tpl);
    const legacy: Legacy = { caps, slots: tpl.slots ?? {}, traces: tpl.traces };
    const def = { key: tpl.key, caps, slots: tpl.slots ?? {}, traces: tpl.traces } as LayerDef;
    return { key: tpl.key, legacy, def };
  });
}

/**
 * Layers added AFTER the transcript, on a component the deleted code never
 * knew. They have no "before" to compare against: the oracles resolve no row
 * for them, which says nothing about a regression. Each is pinned on its own
 * below, and a layer may only be added here together with that pin.
 */
const POST_TRANSCRIPT_LAYERS: ReadonlySet<string> = new Set(['AI_AGENT']);

describe('layer menu rows — bundled-template regression', () => {
  it('covers every bundled layer', () => {
    expect(bundledLayers().length).toBe(45);
  });

  it('resolves the same rows, in the same order, as the sidebar did', () => {
    const diffs = bundledLayers()
      .filter(({ key }) => !POST_TRANSCRIPT_LAYERS.has(key))
      .map(({ key, legacy, def }) => ({
        key,
        was: oracleSidebarRows(legacy),
        now: resolveLayerMenuRows(def).map((r) => r.path),
      }))
      .filter((d) => d.was.join() !== d.now.join());
    expect(diffs).toEqual([]);
  });

  it('lands every layer on the tab it landed on before', () => {
    const diffs = bundledLayers()
      .filter(({ key }) => !POST_TRANSCRIPT_LAYERS.has(key))
      .map(({ key, legacy, def }) => ({ key, was: oracleFirstTab(legacy), now: firstLayerMenuRow(def) }))
      .filter((d) => d.was !== d.now);
    expect(diffs).toEqual([]);
  });

  it('classifies direct-vs-expandable exactly as before — no exceptions', () => {
    // `isSingleFeatureLayer` is the historical predicate AND the row
    // count, so a bundled layer can only ever become MORE expandable —
    // and none of them does. An earlier draft used the row count alone,
    // which turned the three SO11Y agent layers into direct links: a
    // behaviour change to layers declaring neither new field, which the
    // compatibility rule does not permit.
    // `now` calls the PRODUCTION predicate. Restating its formula here
    // was the same drift this file exists to catch: the function could
    // change and the comparison would keep agreeing with itself.
    const diffs = bundledLayers()
      .map(({ key, legacy, def }) => ({
        key,
        was: oracleSingleFeature(legacy),
        now: isSingleFeatureLayer(def),
      }))
      .filter((d) => d.was !== d.now);
    expect(diffs).toEqual([]);
  });

  it('gives every bundled layer at least one row to land on', () => {
    const empty = bundledLayers().filter(({ def }) => resolveLayerMenuRows(def).length === 0);
    expect(empty.map((e) => e.key)).toEqual([]);
  });
});

/**
 * The default order has to cover the COMPONENT LIST, not just the layers
 * that happen to exist. Enabling one component at a time and asking what
 * it resolves to ties the two together in both directions: a component
 * added without a row would ship a feature the sidebar can never reach,
 * and a row no component can produce is dead weight in the order.
 */
describe('default order vs. the component list', () => {
  const COMPONENT_KEYS = Object.keys(componentsSchema.shape);

  /** Rows a layer shows with exactly one component enabled. `service`
   *  defaults to ON when absent, so the base turns it off explicitly —
   *  otherwise every case would also report the Service row. */
  function rowsForComponent(key: string): string[] {
    const t = {
      key: 'PROBE',
      slots: {},
      components: { service: false, [key]: true },
      // Two components are gated on a config block as well as their flag.
      ...(key === 'deployment' ? { deployment: { roles: [], roleToRole: [] } } : {}),
      // `traces` carries two rows when the layer ships both span formats.
      ...(key === 'traces' ? { traces: { source: 'both' as const } } : {}),
    } as unknown as LayerTemplate;
    const caps = capsForTemplate(t, t);
    return resolveLayerMenuRows({ caps, slots: {}, traces: t.traces }).map((r) => r.path);
  }

  it('covers all 17 components', () => {
    expect(COMPONENT_KEYS).toHaveLength(17);
  });

  it('gives every component at least one row', () => {
    const withoutRow = COMPONENT_KEYS.filter((k) => rowsForComponent(k).length === 0);
    expect(withoutRow).toEqual([]);
  });

  it('contains nothing a component cannot produce', () => {
    const produced = new Set(COMPONENT_KEYS.flatMap(rowsForComponent));
    expect([...DEFAULT_LAYER_ROW_ORDER].sort()).toEqual([...produced].sort());
  });

  it('is one row per component, plus the second trace row', () => {
    // 17 components → 18 rows: `traces` is the only one that resolves to
    // two (native and Zipkin span formats get their own tabs).
    expect(DEFAULT_LAYER_ROW_ORDER).toHaveLength(COMPONENT_KEYS.length + 1);
    const multi = COMPONENT_KEYS.filter((k) => rowsForComponent(k).length > 1);
    expect(multi).toEqual(['traces']);
    expect(rowsForComponent('traces')).toEqual(['trace', 'zipkin-trace']);
  });
});

describe('layers added after the transcript', () => {
  it('lists exactly the post-transcript layers, so an addition here is deliberate', () => {
    const keys = bundledLayers().map((l) => l.key);
    for (const k of POST_TRANSCRIPT_LAYERS) expect(keys).toContain(k);
  });

  it('AI_AGENT is its Conversations tab: one row, the landing, and a direct link', () => {
    const ai = bundledLayers().find((l) => l.key === 'AI_AGENT')!;
    // The frozen sidebar had no row for it at all — which is why it is not a
    // regression subject above.
    expect(oracleSidebarRows(ai.legacy)).toEqual([]);
    expect(resolveLayerMenuRows(ai.def).map((r) => r.path)).toEqual(['conversations']);
    expect(firstLayerMenuRow(ai.def)).toBe('conversations');
    expect(isSingleFeatureLayer(ai.def)).toBe(true);
  });
});

/**
 * The four divergences the old code carried. None is reachable by a
 * bundled layer — the suite above proves that — but a custom template can
 * reach all of them, so each is pinned here with the behaviour it now has.
 */
/** A synthetic layer — the shape the menu route serves. */
function L(caps: Partial<LayerCaps>, slots: Partial<LayerSlots> = {}): LayerDef {
  return { key: 'X', caps, slots } as LayerDef;
}

describe('layer menu rows — divergences the unification resolves', () => {

  it('orders the profiling tail as the sidebar did, not as firstLayerTab did', () => {
    // The two chains disagreed: firstLayerTab put async-profiling before
    // pprof before continuous-profiling; the sidebar renders continuous,
    // then pprof, then async. A layer with only async + continuous was
    // therefore sent to a tab that was not its first visible row.
    const layer = L({ asyncProfiling: true, continuousProfiling: true });
    expect(oracleFirstTab({ caps: layer.caps, slots: layer.slots })).toBe('async-profiling');
    expect(oracleSidebarRows({ caps: layer.caps, slots: layer.slots })[0]).toBe('continuous-profiling');
    expect(firstLayerMenuRow(layer)).toBe('continuous-profiling');
  });

  it.each([
    ['podLogs', { dashboards: true, podLogs: true }, 'pod-logs'],
    ['networkProfiling', { dashboards: true, networkProfiling: true }, 'network-profiling'],
    ['pprofProfiling', { dashboards: true, pprofProfiling: true }, 'pprof'],
    ['continuousProfiling', { dashboards: true, continuousProfiling: true }, 'continuous-profiling'],
  ] as const)(
    'expands a layer whose only second row is %s — the old predicate hid it',
    (_name, caps, path) => {
      const layer = L(caps);
      expect(oracleSingleFeature({ caps: layer.caps, slots: layer.slots })).toBe(true);
      const rows = resolveLayerMenuRows(layer).map((r) => r.path);
      expect(rows).toEqual(['service', path]);
      // Call the PRODUCT's predicate, not a restatement of its formula:
      // `rows.length <= 1` is the rule's own arithmetic, so asserting it
      // here would pass however `isSingleFeatureLayer` were written.
      expect(isSingleFeatureLayer(layer)).toBe(false);
    },
  );

  it('still lets caps.events alone make a layer expandable, deliberately', () => {
    // `events` produces no menu row, yet the frozen predicate treats it as
    // proof of a second screen — so such a layer is an accordion holding a
    // single Service row. Kept bug-for-bug: correcting it would change how
    // a bundled layer is REACHED, which this feature promised not to do.
    // The row count only ever makes a layer MORE expandable, never less.
    const layer = L({ dashboards: true, events: true });
    expect(oracleSingleFeature({ caps: layer.caps, slots: layer.slots })).toBe(false);
    expect(resolveLayerMenuRows(layer).map((r) => r.path)).toEqual(['service']);
  });
});

/**
 * The row-count half of `isSingleFeatureLayer`, called rather than
 * restated.
 *
 * The rule is `historicallySingleFeature(L) && rows.length <= 1`. The
 * conjunction is the compatibility promise: the count may only make a
 * layer MORE expandable, never less, so no layer that predates extension
 * pages can change how it is reached. Asserting `rows.length <= 1` in the
 * test proves nothing about the function — it is the same arithmetic.
 */
describe('isSingleFeatureLayer, exercised through the function itself', () => {
  it('is a direct link when the frozen predicate says so AND one row resolves', () => {
    const layer = L({ dashboards: true });
    expect(resolveLayerMenuRows(layer)).toHaveLength(1);
    expect(isSingleFeatureLayer(layer)).toBe(true);
  });

  it('expands as soon as a SECOND row resolves, whatever the frozen predicate said', () => {
    const layer = L({ dashboards: true, pprofProfiling: true });
    expect(oracleSingleFeature({ caps: layer.caps, slots: layer.slots })).toBe(true);
    expect(isSingleFeatureLayer(layer)).toBe(false);
  });

  it('an extension page is a second row, so it makes a one-row layer expandable', () => {
    const bare = L({ dashboards: true });
    expect(isSingleFeatureLayer(bare)).toBe(true);
    const withPage = {
      ...bare,
      extPages: { service: [{ id: 'agents', name: 'Agents' }] },
    };
    expect(resolveLayerMenuRows(withPage).map((r) => r.path)).toEqual(['service', 'service/agents']);
    expect(isSingleFeatureLayer(withPage)).toBe(false);
  });

  it('never turns an expandable layer into a direct link', () => {
    // The half that would break compatibility: a layer the frozen
    // predicate calls multi-feature stays expandable even when it
    // resolves a single row (caps.events produces none).
    const layer = L({ dashboards: true, events: true });
    expect(resolveLayerMenuRows(layer)).toHaveLength(1);
    expect(isSingleFeatureLayer(layer)).toBe(false);
  });
});
