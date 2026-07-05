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
 * kubernetes skill — the one k8s capability the generic metric tools can't
 * cover: LIVE on-demand pod logs, pulled from the K8s API through OAP and never
 * persisted. (K8S / K8S_SERVICE metrics are already reachable via the generic
 * catalog tools; the k8s DOMAIN method lives in the rca `k8s` playbook.) A pod
 * is a ServiceInstance — the agent gets its id from
 * kb_resolve_scope_drill(serviceId, 'instance'); these tools take that id
 * directly, mirroring OAP's ondemandPodLogs / listContainers condition.
 *
 * On-demand logs are pulled per request (never stored): fetch_pod_logs reads the
 * trailing window for the model AND shows those exact lines to the operator
 * inline as a read-only result (emitPodLogs) — not a live tail. The feature is
 * OAP-gated (enableOnDemandPodLog=false by default) — when off, OAP omits the
 * schema field entirely, so a query fails validation rather than returning an
 * errorReason; we translate that into an actionable "enable it" hint instead of
 * a raw failure.
 *
 * These call OAP directly with their own query strings (the metric-catalog skill
 * does the same) — the existing Pod Logs HTTP route is left untouched.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AiRequestContext } from '../../context.js';
import type { PodLogLine } from '../../types.js';
import { graphqlPost } from '../../../client/graphql.js';
import { fmtSecond, getServerOffsetMinutes } from '../../../util/window.js';

const DEFAULT_WINDOW_SEC = 300; // 5m trailing look-back for the agent's read
const MAX_WINDOW_SEC = 30 * 60; // 30m — same ceiling as the Pod Logs tab
const MODEL_LINE_CAP = 80; // lines returned to the model (operator sees the full fetched result)
const MODEL_CHAR_CAP = 8_000;

const QUERY_CONTAINERS = /* GraphQL */ `
  query ListContainers($condition: OndemandContainergQueryCondition) {
    containers: listContainers(condition: $condition) { errorReason containers }
  }
`;
const QUERY_POD_LOGS = /* GraphQL */ `
  query OndemandPodLogs($condition: OndemandLogQueryCondition) {
    logs: ondemandPodLogs(condition: $condition) {
      errorReason
      logs { content timestamp }
    }
  }
`;

interface OapContainers {
  errorReason?: string | null;
  containers?: string[] | null;
}
interface OapPodLogs {
  errorReason?: string | null;
  logs?: Array<{ content?: string | null; timestamp?: number | null }> | null;
}

type ContainerResult =
  | { containers: string[]; errorReason: string | null }
  | { unavailable: true }
  | { error: string };

/** OAP hides the ondemandPodLogs/listContainers schema fields when the feature
 *  is disabled (enableOnDemandPodLog=false), so a query against a stock OAP
 *  fails validation ("Cannot query field …") rather than returning an
 *  errorReason. Recognise that so we can hand the model an actionable hint.
 *  Exported for unit testing. */
export function isFeatureUnavailable(msg: string): boolean {
  return (
    /cannot query field|no such field|unknown field|undefined field|validation error/i.test(msg) &&
    /listcontainers|ondemandpodlogs/i.test(msg)
  );
}

const ENABLE_HINT =
  'On-demand pod logs are not enabled on this OAP (the query module\'s enableOnDemandPodLog is off by default, and OAP needs Kubernetes RBAC to read pod logs). Ask the operator to enable it in OAP config; until then pod logs are unavailable — continue with metrics, hierarchy and network signal instead.';

function capForModel(lines: PodLogLine[]): { text: string; shown: number; truncated: boolean } {
  const tail = lines.slice(-MODEL_LINE_CAP);
  let text = tail.map((l) => l.content).join('\n');
  let truncated = tail.length < lines.length;
  if (text.length > MODEL_CHAR_CAP) {
    text = text.slice(text.length - MODEL_CHAR_CAP);
    truncated = true;
  }
  return { text, shown: tail.length, truncated };
}

export function kubernetesTools(ctx: AiRequestContext): StructuredToolInterface[] {
  const denied = (): string => 'Permission denied: the current user lacks logs:read.';

  async function queryContainers(serviceInstanceId: string): Promise<ContainerResult> {
    try {
      const data = await graphqlPost<{ containers: OapContainers }>(ctx.opts, QUERY_CONTAINERS, {
        condition: { serviceInstanceId },
      });
      const c = data.containers ?? {};
      return { containers: c.containers ?? [], errorReason: c.errorReason ? c.errorReason : null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isFeatureUnavailable(msg)) return { unavailable: true };
      return { error: msg };
    }
  }

  const list = tool(
    async ({ serviceInstanceId }): Promise<string> => {
      if (!ctx.hasVerb('logs:read')) return denied();
      const r = await queryContainers(serviceInstanceId);
      if ('unavailable' in r) return ENABLE_HINT;
      if ('error' in r) return `Could not list containers: ${r.error}`;
      if (r.errorReason) {
        return `OAP could not read this pod: ${r.errorReason} (the instance id may be a terminated pod — re-pick a live pod via kb_resolve_scope_drill).`;
      }
      if (r.containers.length === 0) return 'No containers found for this pod.';
      return JSON.stringify({
        containers: r.containers,
        note: 'Pass one of these as `container` to fetch_pod_logs (the first is usually the app container).',
      });
    },
    {
      name: 'list_pod_containers',
      description:
        "List the containers of a Kubernetes pod so you can pick which one to read logs from. `serviceInstanceId` is the pod's ServiceInstance id (from kb_resolve_scope_drill(serviceId, 'instance')). On-demand pod logs are OAP-gated (off by default) — if unavailable, this says so.",
      schema: z.object({
        serviceInstanceId: z.string().describe("the pod's ServiceInstance id (from kb_resolve_scope_drill)"),
      }),
    },
  );

  const fetchLogs = tool(
    async (input): Promise<string> => {
      if (!ctx.hasVerb('logs:read')) return denied();
      const { serviceInstanceId } = input;
      const windowSec = Math.min(
        MAX_WINDOW_SEC,
        input.windowSeconds && input.windowSeconds > 0 ? input.windowSeconds : DEFAULT_WINDOW_SEC,
      );

      // Resolve the active container: use the one the model named, else auto-pick
      // the pod's first. queryContainers also validates the pod is live — its
      // error branches abort when NO container was named and none can be read.
      let container = input.container;
      const lc = await queryContainers(serviceInstanceId);
      if ('unavailable' in lc) {
        if (!container) return ENABLE_HINT;
      } else if ('error' in lc) {
        if (!container) return `Could not resolve a container: ${lc.error}`;
      } else if (lc.errorReason) {
        if (!container) {
          return `OAP could not read this pod: ${lc.errorReason} (the instance id may be a terminated pod — re-pick a live pod).`;
        }
      } else {
        if (!container) {
          if (lc.containers.length === 0) return 'No containers found for this pod.';
          container = lc.containers[0];
        }
      }

      // Build a SECOND-precision trailing window in OAP-server-local time.
      const offset = await getServerOffsetMinutes(ctx.config, ctx.fetch);
      const endMs = Date.now();
      const startMs = endMs - windowSec * 1000;
      const duration = {
        start: fmtSecond(startMs, offset),
        end: fmtSecond(endMs, offset),
        step: 'SECOND' as const,
      };

      const condition: Record<string, unknown> = { serviceInstanceId, container, duration };
      if (input.keywordsOfContent?.length) condition.keywordsOfContent = input.keywordsOfContent;
      if (input.excludingKeywordsOfContent?.length) {
        condition.excludingKeywordsOfContent = input.excludingKeywordsOfContent;
      }

      let lines: PodLogLine[] = [];
      let errorReason: string | null = null;
      try {
        const data = await graphqlPost<{ logs: OapPodLogs }>(ctx.opts, QUERY_POD_LOGS, { condition });
        const l = data.logs ?? {};
        errorReason = l.errorReason ? l.errorReason : null;
        lines = (l.logs ?? []).map((row) => ({
          content: row.content ?? '',
          // OAP reports epoch SECONDS; surface ms to match every other timestamp.
          timestamp: typeof row.timestamp === 'number' ? row.timestamp * 1000 : null,
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isFeatureUnavailable(msg)) return ENABLE_HINT;
        return `Could not fetch pod logs: ${msg}`;
      }

      const target = [input.service, input.pod].filter(Boolean).join('/');
      const title = `Pod logs — ${target ? `${target} · ${container}` : container}`;
      // Show the fetched lines to the operator inline (read-only result, no re-poll).
      ctx.emitPodLogs({
        title,
        service: input.service,
        pod: input.pod,
        container,
        keywordsOfContent: input.keywordsOfContent?.length ? input.keywordsOfContent : undefined,
        excludingKeywordsOfContent: input.excludingKeywordsOfContent?.length
          ? input.excludingKeywordsOfContent
          : undefined,
        initialLines: lines,
        errorReason,
      });

      if (errorReason) {
        return `OAP returned no logs: ${errorReason} — the pod may have terminated; re-pick a live pod.`;
      }
      if (lines.length === 0) {
        return `No log lines in the last ${windowSec}s for container "${container}" (the pod may be quiet, or the lines were filtered out). Re-fetch with a wider window, or without keywords.`;
      }
      const { text, shown, truncated } = capForModel(lines);
      return `Fetched ${lines.length} log line(s) for container "${container}" over the last ${windowSec}s; the lines are shown to the operator. ${
        truncated ? `Showing the last ${shown} here` : `All ${shown}`
      }:\n\n${text}`;
    },
    {
      name: 'fetch_pod_logs',
      description:
        'Read a Kubernetes pod container\'s LIVE logs (on-demand, pulled from the K8s API through OAP, never stored) and show the fetched lines to the operator inline (a read-only result, not a live tail). Use this to find the ERROR STACK once metrics point at a pod, and as the main move for a middleware LEAF (a DB/MQ/cache has no downstream to walk — read its logs instead). `serviceInstanceId` is the pod\'s ServiceInstance id (from kb_resolve_scope_drill). Omit `container` to auto-pick the first. FETCH UNFILTERED and read the returned lines YOURSELF to find the error — do NOT guess keywordsOfContent up front: a server-side regex silently drops any error that does not contain your guessed word, and an empty filtered pane looks like a silent pod (misleading the operator). If nothing looks wrong, that IS the finding (the pod is clean); widen the window before concluding it is silent. Use keywordsOfContent (OAP full-line regex) ONLY to grep for an error signature you ALREADY know — e.g. a message seen in a trace span log or an app-log search. OAP-gated: if disabled it tells you so.',
      schema: z.object({
        layer: z.string().describe('OAP layer key of the pod, e.g. K8S_SERVICE'),
        serviceInstanceId: z.string().describe("the pod's ServiceInstance id (from kb_resolve_scope_drill)"),
        container: z
          .string()
          .optional()
          .describe('container name (from list_pod_containers); omit to auto-pick the first'),
        service: z.string().optional().describe('service name (for the block heading)'),
        pod: z.string().optional().describe('pod / instance name (for the block heading)'),
        windowSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'trailing look-back seconds (default 300, max 1800). On-demand logs are collected over time — use a WIDE window (e.g. 1800) and widen before concluding a pod is silent; a narrow window on a quiet pod returns nothing.',
          ),
        keywordsOfContent: z
          .array(z.string().min(1))
          .optional()
          .describe('include only lines matching these (OAP full-line regex) — use ONLY for a KNOWN error signature, never as a first-pass guess; fetch unfiltered otherwise'),
        excludingKeywordsOfContent: z
          .array(z.string().min(1))
          .optional()
          .describe('drop lines matching these (OAP full-line regex)'),
      }),
    },
  );

  return [list, fetchLogs];
}
