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
import type { AiRequestContext } from '../../context.js';
import { graphqlPost } from '../../../client/graphql.js';
import { fmtSecond, getServerOffsetMinutes } from '../../../util/window.js';

const ALARM_WINDOW_MS = 3 * 60 * 60_000; // under OAP's 4h alarm cap

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

export function telemetryTools(ctx: AiRequestContext): StructuredToolInterface[] {
  const listAlarms = tool(
    async ({ layer, keyword }): Promise<string> => {
      if (!ctx.hasVerb('alarms:read')) {
        return 'Permission denied: the current user lacks alarms:read.';
      }
      const offset = await getServerOffsetMinutes(ctx.config, ctx.fetch);
      const endMs = ctx.range.endMs;
      // Independent look-back — NOT clamped to the (often narrower, 60m-default)
      // chat metric range: a still-firing alarm older than the chat window is
      // exactly what "what's unhealthy?" must surface. Fixed ≤3h stays under
      // OAP's 4h alarm cap.
      const startMs = endMs - ALARM_WINDOW_MS;
      const condition: Record<string, unknown> = {
        duration: { start: fmtSecond(startMs, offset), end: fmtSecond(endMs, offset), step: 'SECOND' },
        paging: { pageNum: 1, pageSize: 30 },
      };
      if (layer) condition.layer = layer;
      if (keyword) condition.keyword = keyword;
      try {
        const raw = await graphqlPost<{ queryAlarms?: { msgs?: AlarmMsg[] } }>(ctx.opts, QUERY_ALARMS, {
          condition,
        });
        const msgs = raw.queryAlarms?.msgs ?? [];
        if (msgs.length === 0) return 'No alarms in the recent window — nothing is firing.';
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
      } catch (err) {
        return `Alarm query failed (this OAP may not support queryAlarms): ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
    {
      name: 'list_alarms',
      description:
        "List recently firing alarms — SkyWalking's health signal. Start here for 'what is unhealthy / abnormal?': each alarm names the alarmed entity, scope, and the rule message. Active (unrecovered) alarms are listed first. Then drill into the alarmed entity's metrics to explain the anomaly. Optionally filter by layer or a keyword.",
      schema: z.object({
        layer: z.string().optional().describe('OAP layer key filter, e.g. GENERAL'),
        keyword: z.string().optional().describe('alarm-name / entity keyword filter'),
      }),
    },
  );

  return [listAlarms];
}
