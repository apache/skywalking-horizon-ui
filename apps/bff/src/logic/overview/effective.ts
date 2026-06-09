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
 * Resolve the **in-use** overview dashboards — strictly REMOTE.
 *
 * Runtime is remote-only: bundled disk overviews reach the UI only by
 * being synced INTO OAP (boot seed / admin reset) or via admin preview —
 * never as a render-time fallback. So overviews are enumerated from the
 * OAP rows: non-disabled remote rows win; admin-disabled overviews are
 * dropped (`null` for a single id). When the template store is
 * unreachable this returns empty / `null` — a deliberate feature block
 * (the UI shows the connectivity banner), not stale bundled config.
 *
 * The direct overview routes (`GET /api/overview/dashboards` + `/:id`)
 * MUST go through this — `/:id` is the primary render path. Mirrors
 * {@link resolveEffectiveLayerTemplate} for layers.
 */

import type { OverviewDashboard, UITemplateClient } from '@skywalking-horizon-ui/api-client';
import { getSyncStatus, type TemplateRow } from '../templates/sync.js';
import { iterateBundledTemplates } from '../templates/aggregator.js';
import { formatName, parseEnvelope } from '../templates/names.js';
import { logger } from '../../logger.js';

function isOverviewLike(v: unknown): v is OverviewDashboard {
  return !!v && typeof v === 'object' && 'id' in (v as Record<string, unknown>);
}

async function snapshot(
  uiTemplateClient: () => UITemplateClient,
): Promise<{ rows: TemplateRow[]; unreachable: boolean }> {
  const sync = await getSyncStatus({
    client: uiTemplateClient(),
    bundled: () => iterateBundledTemplates(),
    logger,
  });
  return { rows: sync.rows, unreachable: sync.unreachable };
}

export async function resolveEffectiveOverviews(
  uiTemplateClient: (() => UITemplateClient) | undefined,
): Promise<OverviewDashboard[]> {
  if (!uiTemplateClient) return [];
  try {
    const sync = await snapshot(uiTemplateClient);
    if (sync.unreachable) return []; // template store down → blocked
    const out: OverviewDashboard[] = [];
    for (const row of sync.rows) {
      if (row.kind !== 'overview' || row.status === 'disabled' || !row.remote) continue;
      if (row.locale !== undefined) continue; // skip per-locale overlay rows
      const env = parseEnvelope(row.remote.configuration);
      if (env && isOverviewLike(env.content)) out.push(env.content);
    }
    return out;
  } catch {
    return [];
  }
}

export async function resolveEffectiveOverview(
  uiTemplateClient: (() => UITemplateClient) | undefined,
  id: string,
): Promise<OverviewDashboard | null> {
  if (!uiTemplateClient) return null;
  try {
    const sync = await snapshot(uiTemplateClient);
    if (sync.unreachable) return null;
    const row = sync.rows.find(
      (r) => r.name === formatName('overview', id) && r.kind === 'overview' && r.locale === undefined,
    );
    if (!row || row.status === 'disabled' || !row.remote) return null;
    const env = parseEnvelope(row.remote.configuration);
    return env && isOverviewLike(env.content) ? env.content : null;
  } catch {
    return null;
  }
}
