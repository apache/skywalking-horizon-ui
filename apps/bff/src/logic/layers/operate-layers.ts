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
 * Which layers are operate layers (the Platform monitoring section), read from
 * the layer templates' `visibility` — the same field the menu reads, so what
 * the server enforces and what the sidebar shows cannot disagree.
 *
 * This decides access, so it fails CLOSED. A layer counts as operate when its
 * template says so, and also when nothing is known about it: the template
 * store has never been read and no row was retained. Once the store has been
 * read, a layer with no readable template renders from the in-code defaults,
 * which carry no `visibility`, so it is an ordinary layer — exactly what the
 * menu shows for it.
 */

import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import { getSyncStatus, type SyncStatus } from '../templates/sync.js';
import { iterateBundledTemplates } from '../templates/aggregator.js';
import { parseEnvelope } from '../templates/names.js';
import { canonicalLayerKey } from '../templates/identity.js';
import { logger } from '../../logger.js';

export interface LayerClassification {
  isOperate(layer: string): boolean;
}

const NOTHING_IS_OPERATE: LayerClassification = { isOperate: () => false };
const EVERYTHING_IS_OPERATE: LayerClassification = { isOperate: () => true };

const bySnapshot = new WeakMap<SyncStatus, LayerClassification>();

export function classifySnapshot(sync: SyncStatus): LayerClassification {
  const operate = new Set<string>();
  const known = new Set<string>();
  for (const row of sync.rows) {
    if (row.kind !== 'layer' || row.locale !== undefined) continue;
    // A disabled row still says what the layer is: disabling hides a layer
    // from the menu, it does not make its data an ordinary layer's.
    if (!row.remote || (row.effective !== 'remote' && row.status !== 'disabled')) continue;
    const env = parseEnvelope(row.remote.configuration);
    const content = env?.content as { key?: unknown; visibility?: unknown } | undefined;
    if (!content || typeof content.key !== 'string') continue;
    const key = canonicalLayerKey(row.key);
    if (canonicalLayerKey(content.key) !== key) continue;
    known.add(key);
    if (content.visibility === 'operate') operate.add(key);
  }
  if (!sync.unreachable) return { isOperate: (layer) => operate.has(canonicalLayerKey(layer)) };
  // Unreachable: only a retained row still says anything.
  return {
    isOperate: (layer) => {
      const key = canonicalLayerKey(layer);
      return operate.has(key) || !known.has(key);
    },
  };
}

export async function classifyLayers(
  uiTemplateClient: (() => UITemplateClient) | undefined,
): Promise<LayerClassification> {
  // Tests and deployments with no admin host wired have no templates to read
  // an operate layer from; the in-code defaults name none.
  if (!uiTemplateClient) return NOTHING_IS_OPERATE;
  try {
    const sync = await getSyncStatus({
      client: uiTemplateClient(),
      bundled: () => iterateBundledTemplates(),
      logger,
    });
    let c = bySnapshot.get(sync);
    if (!c) {
      c = classifySnapshot(sync);
      bySnapshot.set(sync, c);
    }
    return c;
  } catch (err) {
    logger.warn({ err }, 'layer classification unavailable — treating every layer as operate');
    return EVERYTHING_IS_OPERATE;
  }
}
