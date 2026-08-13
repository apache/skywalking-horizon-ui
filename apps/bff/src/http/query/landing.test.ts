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
