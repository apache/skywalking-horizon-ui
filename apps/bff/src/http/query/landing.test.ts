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

import { describe, it, expect } from 'vitest';
import { bodySchema } from './landing.js';
import { allLayerTemplates } from '../../logic/layers/loader.js';

/**
 * The SPA turns a layer template's `layer-header` block straight into the
 * landing request body (topN + orderBy + the columns verbatim). Anything the
 * route's schema rejects is a 400 for the WHOLE request — the layer's service
 * list, its KPI strip and every downstream widget gated on a picked service
 * go blank, not just the offending column. So every bundled header must be a
 * body this route accepts.
 */
describe('landing body schema — every bundled layer header is a valid request', () => {
  for (const tpl of allLayerTemplates()) {
    const columns = tpl.header.columns ?? [];
    if (columns.length === 0) continue;
    it(`${tpl.key}`, () => {
      const parsed = bodySchema.safeParse({
        topN: 5,
        orderBy: tpl.header.orderBy || columns[0].metric,
        columns,
      });
      expect(parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe('');
    });
  }
});

// The hourly figures are opt-in: the layer header asks for them, and nothing
// else may be handed them by accident. The schema has to accept the flag, and
// has to keep accepting a body without it — every other caller of this route,
// the Overview included, sends none.
describe('landing body schema — the hourly opt-in', () => {
  const base = { topN: 5, orderBy: 'cpm', columns: [{ metric: 'cpm', label: 'CPM', mqe: 'service_cpm' }] };

  it('accepts the header asking for the completed hour', () => {
    const parsed = bodySchema.safeParse({ ...base, hourlyKpi: true });
    expect(parsed.success && parsed.data.hourlyKpi).toBe(true);
  });

  it('leaves it unset for callers that want the window they sent', () => {
    const parsed = bodySchema.safeParse(base);
    expect(parsed.success && parsed.data.hourlyKpi).toBeUndefined();
  });

  it('refuses a non-boolean rather than coercing it', () => {
    expect(bodySchema.safeParse({ ...base, hourlyKpi: 'yes' }).success).toBe(false);
  });
});

// The metric allowlist fails CLOSED. A layer that declares nothing — no header
// block, a template that could not be read, a layer an administrator disabled —
// allows nothing by name, because the moment the template cannot be read is the
// moment "the template decides" matters most.
describe('landing body schema — a column that names a metric', () => {
  it('is distinguishable from one that carries its own expression', () => {
    // The route refuses an undeclared NAME; a column with an `mqe` is naming an
    // expression to evaluate and is not making a claim about the layer. The
    // schema has to keep both shapes parseable for that distinction to exist.
    const named = bodySchema.safeParse({
      topN: 5,
      orderBy: 'cpm',
      columns: [{ metric: 'cpm', label: 'CPM' }],
    });
    expect(named.success && named.data.columns[0].mqe).toBeUndefined();

    const expression = bodySchema.safeParse({
      topN: 5,
      orderBy: 'w_0',
      columns: [{ metric: 'w_0', label: 'RPM', mqe: 'service_cpm' }],
    });
    expect(expression.success && expression.data.columns[0].mqe).toBe('service_cpm');
  });
});
