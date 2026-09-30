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
 * telemetry skill — event-style signals. `list_alarms` is the health entry
 * point ("what's unhealthy?"): active alarms are SkyWalking's anomaly signal,
 * each naming the alarmed entity + the rule that fired, so the agent can then
 * drill into that entity's metrics. Alarms are second-precision + capped at a
 * short window, so this tool owns its own ≤3h range (not the chat metric range).
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { alarmPinMatches, formatAlarmPin, layerFilterPin } from '@skywalking-horizon-ui/api-client';
import type { ToolContext } from '../../tool-context.js';
import { graphqlPost } from '../../../../client/graphql.js';
import { fmtSecond, getServerOffsetMinutes } from '../../../../util/window.js';
import { readFilteredPage } from '../../../../logic/paging/read-page.js';
import { serviceLayerCatalog } from '../../../../logic/services/service-layer-catalog.js';
import { ServiceLookupUnavailable, catalogIndex } from '../../../../logic/services/service-identity.js';
import { alarmLayers, alarmOwners } from '../../../../logic/alarms/owners.js';
import { AlarmRowAccess, keepAll, readsEveryAlarm } from '../../../../logic/alarms/readable.js';
import { canonicalLayerKey } from '../../../../logic/templates/identity.js';
import { toolPrompt } from '../../skills/loader.js';
import { denied, holds, unverifiable } from '../access.js';

const ALARM_WINDOW_MS = 3 * 60 * 60_000; // under OAP's 4h alarm cap
const ALARM_ROWS = 30;
/** How far a filtered read looks for its rows — see `readFilteredPage`. */
const FILTERED_READ = { first: 200, maxRows: 2_000 };

const QUERY_ALARMS = /* GraphQL */ `
  query AiQueryAlarms($condition: AlarmQueryCondition!) {
    queryAlarms(condition: $condition) {
      msgs { id startTime recoveryTime scope name message tags { key value } }
    }
  }
`;

interface AlarmMsg {
  id: string;
  startTime: number;
  recoveryTime?: number | null;
  scope: string;
  name: string;
  message: string;
  tags?: Array<{ key: string; value: string }>;
}

export function telemetryTools(ctx: ToolContext): StructuredToolInterface[] {
  const alarms = toolPrompt('telemetry', 'list_alarms');
  const listAlarms = tool(
    async ({ layer, keyword }): Promise<string> => {
      if (!holds(ctx, 'alarms:read')) return denied('alarms:read');
      const offset = await getServerOffsetMinutes(ctx.config, ctx.fetch);
      const endMs = ctx.range.endMs;
      // Independent look-back — NOT clamped to the (often narrower, 60m-default)
      // chat metric range: a still-firing alarm older than the chat window is
      // exactly what "what's unhealthy?" must surface. Fixed ≤3h stays under
      // OAP's 4h alarm cap.
      const startMs = endMs - ALARM_WINDOW_MS;
      const duration = { start: fmtSecond(startMs, offset), end: fmtSecond(endMs, offset), step: 'SECOND' };
      // OAP stores one layer per alarm, so the layer is applied here by the
      // layers of the services an alarm concerns, as the Alarms page does.
      const fetchFirst = async (rows: number): Promise<AlarmMsg[]> => {
        const condition: Record<string, unknown> = { duration, paging: { pageNum: 1, pageSize: rows } };
        if (keyword) condition.keyword = keyword;
        const raw = await graphqlPost<{ queryAlarms?: { msgs?: AlarmMsg[] } }>(ctx.opts, QUERY_ALARMS, { condition });
        return raw.queryAlarms?.msgs ?? [];
      };
      // A layer, or service groups of it as `GENERAL[payments]`.
      const wantedPin = layer ? layerFilterPin(layer, canonicalLayerKey) : null;
      if (layer && !wantedPin) return `"${layer}" is not a layer. Name a layer key such as GENERAL, or its service groups as GENERAL[payments].`;
      const wanted = wantedPin ? formatAlarmPin(wantedPin) : null;
      const everything = readsEveryAlarm(ctx.access);
      let msgs: AlarmMsg[];
      // The filtered read stops at its budget: an empty answer from it then
      // proves nothing about the alarms it did not read.
      let unread = false;
      try {
        if (everything && !wanted) {
          msgs = await fetchFirst(ALARM_ROWS);
        } else {
          const cat = await serviceLayerCatalog({ config: ctx.config, fetch: ctx.fetch }).get();
          if (cat.unreachable && cat.byLayer.size === 0) {
            return 'The service catalog could not be read, so alarms cannot be told apart by the services they concern right now. This is not a permission problem; try again shortly.';
          }
          const index = catalogIndex(cat);
          const rowAccess = ctx.access && !everything ? new AlarmRowAccess(ctx.access) : null;
          const page = await readFilteredPage(
            async (rows) => {
              const fetched = await fetchFirst(rows);
              return rowAccess ? rowAccess.decide(fetched) : keepAll(fetched);
            },
            (d) => d.kept && (!wantedPin || alarmPinMatches(wantedPin, { layerKeys: alarmLayers(d.row, index), owners: alarmOwners(d.row, index) })),
            { pageNum: 1, pageSize: ALARM_ROWS },
            FILTERED_READ,
          );
          msgs = page.rows.map((d) => d.row);
          unread = page.hasNext;
        }
      } catch (err) {
        if (err instanceof ServiceLookupUnavailable) return unverifiable('each alarmed service');
        return `Alarm query failed (this OAP may not support queryAlarms): ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      if (msgs.length === 0 && unread) {
        const which = [wanted ? `in layer ${wanted}` : '', everything ? '' : 'about a service the current user may read']
          .filter(Boolean)
          .join(' and ');
        return `None of the newest ${FILTERED_READ.maxRows} alarms in the recent window is ${which}, and the older alarms in the window were not read — this does not show that nothing is firing. Narrow the search with a keyword.`;
      }
      if (msgs.length === 0) {
        // Only an unfiltered read may say nothing is firing anywhere.
        if (wanted) return `No alarms in the recent window for layer ${wanted}.`;
        if (!everything) return 'No alarms in the recent window among the services the current user may read.';
        return 'No alarms in the recent window — nothing is firing.';
      }
      // Active (not yet recovered) first — those are the live problems.
      const rows = msgs
        .map((m) => ({
          name: m.name,
          scope: m.scope,
          message: m.message,
          entity: m.tags?.find((t) => t.key === 'entityName' || t.key === 'name')?.value,
          active: !m.recoveryTime,
        }))
        .sort((a, b) => Number(b.active) - Number(a.active));
      return JSON.stringify(rows);
    },
    {
      name: 'list_alarms',
      description: alarms.description,
      schema: z.object({
        layer: z.string().optional().describe(alarms.p('layer')),
        keyword: z.string().optional().describe(alarms.p('keyword')),
      }),
    },
  );

  return [listAlarms];
}
