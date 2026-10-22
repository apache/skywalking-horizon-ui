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
 * A layer is marked diverged when OAP's copy differs from the bundled one, and
 * the way back is Reset to bundled, Save, Check diff & push. Save cleans the
 * template first, so a bundled template the cleaning would change could never
 * be saved as shipped: the push would match OAP's copy, and the layer would
 * stay diverged with nothing to push.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdminLayerTemplate } from '@/api/client';
import { cleanLayerTemplate } from './cleanLayerTemplate';

const BUNDLED_LAYERS = join(__dirname, '../../../../../bff/src/bundled_templates/layers');
const files = readdirSync(BUNDLED_LAYERS).filter((f) => f.endsWith('.json') && !f.includes('.i18n.'));

describe('bundled layer templates', () => {
  it('are found', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s is saved after Reset to bundled exactly as shipped', (file) => {
    const shipped = JSON.parse(readFileSync(join(BUNDLED_LAYERS, file), 'utf8')) as AdminLayerTemplate;
    const saved = structuredClone(shipped);
    cleanLayerTemplate(saved, structuredClone(shipped));
    expect(saved).toEqual(shipped);
  });
});
