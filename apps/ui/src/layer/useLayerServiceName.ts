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

import { computed, type ComputedRef, type Ref } from 'vue';
import { useSelectedService } from './useSelectedService';
import { useLayerServices, type LayerServiceRow } from './useLayerServices';
import type { useLayerLanding } from './useLayerLanding';
import { isBlankServiceName, BLANK_SERVICE_NAME } from '@/utils/serviceName';
import { serviceById, serviceByName, type ServiceRef } from '@/utils/serviceRef';

/**
 * Where resolution stands for the selected service.
 *
 *   - `idle`      — nothing selected, and the feeds that would auto-pick have
 *                   settled. There is no service to scope by.
 *   - `resolving` — a lookup is still outstanding. A service-scoped query MUST
 *                   NOT run yet: with no service the BFF answers with EVERY
 *                   service, and the page would show that as the picked one.
 *   - `resolved`  — `name` is the selected service's name.
 *   - `unknown`   — settled, and the selected id is in neither feed. Surface
 *                   the refusal; do not widen the query.
 */
export type ServiceNameStatus = 'idle' | 'resolving' | 'resolved' | 'unknown';

export interface LayerServiceName {
  /** The resolved name — non-null only while `status` is `resolved`. */
  name: ComputedRef<string | null>;
  /** The service handle a query should carry: the picked OAP id, which is what
   *  the picker selected by. Non-null only while `status` is `resolved`, so it
   *  gates like `name` does — but it reaches OAP as an id, never re-resolved
   *  from the name it was displayed under. */
  ref: ComputedRef<ServiceRef | null>;
  status: ComputedRef<ServiceNameStatus>;
}

interface ResolveInput {
  selectedId: string | null;
  landingRows: Array<{ serviceId: string; serviceName: string }>;
  /** The landing rollup answered (or failed) — no lookup is outstanding. */
  landingSettled: boolean;
  roster: LayerServiceRow[];
  /** The full roster answered (or failed) — no lookup is outstanding. */
  rosterSettled: boolean;
}

/**
 * The resolution itself, as a pure function of the two feeds — kept separate
 * from the reactive wiring so the "still resolving" vs "resolved to nothing"
 * distinction is directly testable.
 *
 * OAP's reserved blank-entity service reports an EMPTY name over the wire (its
 * id base64-decodes to `_blank`). It resolves to the literal `_blank` so the
 * name is a non-empty, queryable key — OAP coerces `_blank` back to the same
 * id. An empty name would no-op every per-service query and hang the tab.
 */
export function resolveLayerServiceName(input: ResolveInput): {
  name: string | null;
  /** The selected OAP id, echoed once the feeds confirm the layer really has
   *  it. Queries scope by THIS, not by the name below — the name is for the
   *  operator to read. */
  id: string | null;
  status: ServiceNameStatus;
} {
  const { selectedId } = input;
  if (!selectedId) {
    // The tabs auto-pick the first landing row, so "no selection" is only
    // final once landing has answered.
    return { name: null, id: null, status: input.landingSettled ? 'idle' : 'resolving' };
  }
  const match = input.landingRows.find((r) => r.serviceId === selectedId);
  if (match) {
    return {
      name: isBlankServiceName(match.serviceName) ? BLANK_SERVICE_NAME : match.serviceName,
      id: selectedId,
      status: 'resolved',
    };
  }
  const fromRoster = input.roster.find((s) => s.id === selectedId);
  if (fromRoster) {
    return {
      name: isBlankServiceName(fromRoster.name) ? BLANK_SERVICE_NAME : fromRoster.name,
      id: selectedId,
      status: 'resolved',
    };
  }
  if (!input.landingSettled || !input.rosterSettled) return { name: null, id: null, status: 'resolving' };
  return { name: null, id: null, status: 'unknown' };
}

/**
 * Resolve the selected service's NAME for a layer tab — sample first,
 * then the full roster.
 *
 * The landing rollup only carries the metric-probed sample (the top
 * `query.landingServiceCap` services), so a service picked from the long
 * tail of a big layer — or arriving via a deep link — is NOT in
 * `sampledRows`. Resolving names from the sample alone returns `null` for
 * those, which silently breaks the tab's per-service query (logs/traces
 * fire with no service; endpoint-dependency never enables). We look in
 * the sample first (already loaded), then fall back to the full roster
 * (`useLayerServices`), so EVERY selectable service yields a name.
 *
 * `name` alone cannot be used to gate a service-scoped query: it is null both
 * while a lookup is in flight and when the id matched nothing, and a query
 * fired in the first case reaches the BFF with no service — which reads as ALL
 * services. Trailing controls take the gate from {@link useLayerTabService}
 * and render the `resolving` / `unknown` states themselves.
 *
 * This is the single source of truth for service-name resolution across
 * every per-layer tab. Keep the lookup here — re-inlining it is exactly
 * how tabs drifted into sample-only lookups that drop tail selections.
 */
export function useLayerServiceName(
  layerKey: Ref<string>,
  landing: ReturnType<typeof useLayerLanding>,
  /** REPLAY mode gate: a replayed chat block takes its service from the captured
   *  spec, so the roster fallback must fire ZERO queries (and skip the ticker). */
  replay?: Ref<boolean>,
): LayerServiceName {
  const { selectedId } = useSelectedService();
  const { services: roster, data: rosterData, isError: rosterFailed } = useLayerServices(layerKey, { replay });
  // "Settled" is data-in-hand, not "not fetching": both queries are created
  // during setup and only start fetching on mount, so an isFetching check would
  // read as settled for the first tick and flash `unknown`. A failed read still
  // settles — there is nothing more to wait for, and the refusal is honest.
  const resolution = computed(() =>
    resolveLayerServiceName({
      selectedId: selectedId.value,
      landingRows: landing.data.value?.sampledRows ?? landing.rows.value ?? [],
      landingSettled: landing.data.value !== null || Boolean(landing.error.value),
      roster: roster.value,
      rosterSettled: rosterData.value !== null || rosterFailed.value,
    }),
  );
  return {
    name: computed(() => resolution.value.name),
    ref: computed(() => serviceById(resolution.value.id)),
    status: computed(() => resolution.value.status),
  };
}

export interface LayerTabService extends LayerServiceName {
  /** The gate every service-scoped query on the tab hangs off: true ONLY once
   *  the tab's service is known. `resolving` and `unknown` both read as a null
   *  name, and a query fired with a null service reaches the BFF with no
   *  service at all — which it answers with EVERY service in the layer. */
  ready: ComputedRef<boolean>;
}

/**
 * The service a per-layer TAB queries by. Kept a pure function because THIS
 * decision — not the name lookup — is what every query on the tab hangs off.
 *
 * An embedded (AI-chat) block is scoped by the caller's prop, not by the
 * picker, so the prop alone decides: the resolver's answer is irrelevant there
 * and its `resolving` window must not park a block that already knows its
 * service.
 */
export function tabServiceScope(
  resolution: { name: string | null; ref: ServiceRef | null; status: ServiceNameStatus },
  embedded: boolean,
  focusService: string | null | undefined,
): { name: string | null; ref: ServiceRef | null; status: ServiceNameStatus; ready: boolean } {
  if (embedded) {
    // A chat block is scoped by NAME — the prompt named a service, no picker
    // ever handed the block an id — so that is what its queries carry.
    const name = focusService && focusService.length > 0 ? focusService : null;
    return {
      name,
      ref: serviceByName(name),
      status: name === null ? 'idle' : 'resolved',
      ready: name !== null,
    };
  }
  return { ...resolution, ready: resolution.status === 'resolved' };
}

/**
 * {@link useLayerServiceName} for a layer TAB — the route's picked service, or
 * the embed prop when the tab is mounted inside a chat block, plus the `ready`
 * gate its queries must respect.
 *
 * Every tab that scopes an OAP read by service name goes through here rather
 * than testing `name` itself: `name` is null both while the lookup is in flight
 * and when it resolved to nothing, and only the first of those is a reason to
 * wait quietly. The second must be shown as the refusal it is.
 */
export function useLayerTabService(
  layerKey: Ref<string>,
  landing: ReturnType<typeof useLayerLanding>,
  opts: {
    embedded: Ref<boolean>;
    focusService: Ref<string | null | undefined>;
    replay?: Ref<boolean>;
  },
): LayerTabService {
  const resolved = useLayerServiceName(layerKey, landing, opts.replay);
  const scope = computed(() =>
    tabServiceScope(
      { name: resolved.name.value, ref: resolved.ref.value, status: resolved.status.value },
      opts.embedded.value,
      opts.focusService.value,
    ),
  );
  return {
    name: computed(() => scope.value.name),
    ref: computed(() => scope.value.ref),
    status: computed(() => scope.value.status),
    ready: computed(() => scope.value.ready),
  };
}
