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
 * Switching a component off must not leave a draft that cannot be pushed.
 *
 * A stored order naming a row the layer no longer has is refused at
 * publish, and the editor stops drawing that row — so the draft looks
 * right and the push fails, with nothing on screen connecting the two.
 *
 * The editor prunes against the rows that ACTUALLY resolve rather than a
 * table of which component owns which row. This pins the property that
 * makes that the right shape: components own different NUMBERS of rows
 * (Traces alone owns two), so any table would have to be maintained in
 * step with the row registry.
 */

import { describe, it, expect } from 'vitest';
import { resolveLayerMenuRows } from '@skywalking-horizon-ui/api-client';
import { componentsToCaps } from '@/shell/layerFromTemplate';
import { isBuiltInOrder, pruneMenuOrder } from './menuOrder';

/** Calls the EDITOR's own pruning, not a copy of it: a re-implementation
 *  here passes while the editor does something else, which is exactly the
 *  drift this file exists to catch. */
function prune(components: Record<string, boolean>, order: string[]): string[] {
  const rows = resolveLayerMenuRows({
    caps: componentsToCaps(components),
    slots: {},
  });
  return pruneMenuOrder(order, rows.map((r) => r.path));
}

describe('menu order after a component toggle', () => {
  it('drops the row a disabled component owned', () => {
    const before = { service: true, logs: true };
    expect(prune(before, ['service', 'logs'])).toEqual(['service', 'logs']);
    expect(prune({ service: true, logs: false }, ['service', 'logs'])).toEqual(['service']);
  });

  it('drops BOTH rows when one component owns two', () => {
    // Traces owns `trace` and `zipkin-trace`. A per-component table that
    // mapped one row each would have left the second entry behind.
    const on = { service: true, traces: true };
    const withZipkin = { ...on, tracesSource: undefined };
    const rows = resolveLayerMenuRows({
      caps: componentsToCaps(withZipkin),
      slots: {},
      traces: { source: 'both' },
    }).map((r) => r.path);
    expect(rows).toEqual(expect.arrayContaining(['trace', 'zipkin-trace']));

    const live = new Set(
      resolveLayerMenuRows({ caps: componentsToCaps({ service: true, traces: false }), slots: {} }).map(
        (r) => r.path,
      ),
    );
    expect(['service', 'trace', 'zipkin-trace'].filter((p) => live.has(p))).toEqual(['service']);
  });

  it('keeps every row that still resolves', () => {
    const c = { service: true, instances: true, logs: true };
    expect(prune(c, ['logs', 'service', 'instance'])).toEqual(['logs', 'service', 'instance']);
  });

  it('needs no counterpart when a component is switched back ON', () => {
    // Absence from the order means "default position", so a row that
    // returns simply takes its place again — there is nothing to restore.
    const back = { service: true, logs: true };
    const rows = resolveLayerMenuRows({ caps: componentsToCaps(back), slots: {} }).map((r) => r.path);
    expect(rows).toContain('logs');
    expect(prune(back, ['service'])).toEqual(['service']);
  });
});

/**
 * An arrangement equal to the built-in order is not an arrangement. The
 * editor stores nothing for it, so dragging back to where you started
 * leaves no pending change against OAP.
 */
describe('an order that says what absence already says', () => {
  const builtIn = ['service', 'instance', 'endpoint', 'topology'];

  it('is recognised so the editor can drop it', () => {
    expect(isBuiltInOrder(['service', 'instance', 'endpoint', 'topology'], builtIn)).toBe(true);
  });

  it('is not confused with a real rearrangement', () => {
    expect(isBuiltInOrder(['instance', 'service', 'endpoint', 'topology'], builtIn)).toBe(false);
  });

  it('is not confused with a different SET of the same length', () => {
    // Same count, one entry swapped for another — order alone is not the
    // question, membership is part of it.
    expect(isBuiltInOrder(['service', 'instance', 'endpoint', 'logs'], builtIn)).toBe(false);
  });

  it('treats a shorter or longer order as its own arrangement', () => {
    expect(isBuiltInOrder(['service', 'instance', 'endpoint'], builtIn)).toBe(false);
    expect(isBuiltInOrder([...builtIn, 'logs'], builtIn)).toBe(false);
  });
});
