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
 * Pure helpers for the multi-entity dashboard fan-out (Option B): when a
 * cohort of entities is locked the UI issues ONE single-entity dashboard
 * request per locked entity (reusing the existing endpoint) instead of
 * folding them into one server-side call. These functions are the
 * testable core — the composable (`useLayerDashboard`) wires them to
 * vue-query's `useQueries`.
 */

import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';

/** Max simultaneous in-flight per-entity requests. Sequential at 1; the
 *  cohort cap (6) bounds the total. Keeps a locked cohort from spiking
 *  the OAP with N concurrent dashboard batches. */
export const ENTITY_FANOUT_CONCURRENCY = 3;

export type FanoutScope = 'service' | 'instance' | 'endpoint';

export interface FanoutRange {
  step: 'MINUTE' | 'HOUR' | 'DAY';
  startMs: number;
  endMs: number;
}

/** Single-entity dashboard request body (subset of the BFF contract). */
export interface DashboardBody {
  service?: string;
  serviceInstance?: string;
  endpoint?: string;
  scope?: string;
  step?: 'MINUTE' | 'HOUR' | 'DAY';
  startMs?: number;
  endMs?: number;
  widgets?: DashboardWidget[];
}

/**
 * Bound concurrent async tasks at `max`; excess tasks queue FIFO and run
 * as slots free. `run(task)` resolves with the task's result (or rejects
 * if it throws — the slot is still released). `max = 1` ⇒ sequential.
 */
export function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  function release(): void {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  }
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/**
 * The entities to FAN OUT — the locked comparison set minus the primary
 * (and minus empties). The primary is already served by the single
 * dashboard query, so the fan-out only fetches the additional locked
 * entities. The comparison set's render order is just the locked set as-is
 * (the primary is a member iff it's locked); there's no primary-first
 * reordering, so callers use the locked array directly for ordering.
 */
export function fanoutEntities(primary: string | null, locked: readonly string[]): string[] {
  return locked.filter((e) => e.length > 0 && e !== primary);
}

/**
 * Build a single-entity request body. `entityService` is the service to
 * query; `entityName` is the instance/endpoint within it (empty at
 * service scope, where the service IS the entity). Instance/endpoint
 * pins are cross-service, so each carries its OWN service here.
 */
export function entityDashboardBody(
  scope: FanoutScope,
  entityService: string | null,
  entityName: string,
  range: FanoutRange | null,
  widgets: DashboardWidget[] | null,
): DashboardBody {
  const body: DashboardBody = { scope };
  if (entityService) body.service = entityService;
  if (scope === 'instance' && entityName) body.serviceInstance = entityName;
  if (scope === 'endpoint' && entityName) body.endpoint = entityName;
  if (range) {
    body.step = range.step;
    body.startMs = range.startMs;
    body.endMs = range.endMs;
  }
  if (widgets && widgets.length > 0) body.widgets = widgets;
  return body;
}

/**
 * vue-query key for one entity's dashboard — mirrors the single query's
 * key shape (the entity's own service + the instance/endpoint name) so a
 * previously viewed entity is served warm from cache when it's locked.
 */
export function entityDashboardKey(
  layerKey: string,
  scope: FanoutScope,
  entityService: string | null,
  entityName: string,
  mockTop: number,
  rangeKey: string | null,
  widgetsJson: string | null,
): Array<string | number | null> {
  return [
    'dashboard',
    layerKey,
    entityService,
    scope,
    mockTop,
    scope === 'instance' ? entityName : null,
    scope === 'endpoint' ? entityName : null,
    rangeKey,
    widgetsJson,
  ];
}
