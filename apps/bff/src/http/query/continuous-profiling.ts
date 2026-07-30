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
 * Continuous (auto-triggered) profiling policy routes.
 *
 * The rules that make OAP start a profiling task BY ITSELF when a process
 * crosses a threshold, unlike the profiling tabs which create tasks on demand.
 * Thin routes reach `client/` directly; the layer-wide policy summary is a
 * fan-out, so it goes through `logic/`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ContinuousProfilingInstancesResponse,
  ContinuousProfilingMonitorType,
  ContinuousProfilingPoliciesResponse,
  ContinuousProfilingPolicyItem,
  ContinuousProfilingPolicyRequest,
  ContinuousProfilingPolicyTarget,
  ContinuousProfilingSetResponse,
  ContinuousProfilingTargetType,
  FetchLike,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { policySummaryForServices } from '../../logic/oap/continuous-profiling.js';
import { graphqlPost, buildOapOpts } from '../../client/graphql.js';
import { serviceLayerCatalog } from '../../logic/services/service-layer-catalog.js';

export interface ContinuousProfilingRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

/** OAP's per-target shape, before we fold the targets into one roster. */
interface WireInstance {
  id: string;
  name: string;
  triggeredCount: number;
  lastTriggerTimestamp: number | null;
  processes: Array<{
    id: string;
    name: string;
    detectType: string;
    labels: string[];
    triggeredCount: number;
    lastTriggerTimestamp: number | null;
  }>;
}

const VALID_TARGETS = new Set<string>(['ON_CPU', 'OFF_CPU', 'NETWORK']);
// Validated here only so a malformed body fails readably instead of with a
// GraphQL enum-coercion error. OAP stays the authority on policy content.
const VALID_MONITORS = new Set<string>([
  'PROCESS_CPU',
  'PROCESS_THREAD_COUNT',
  'SYSTEM_LOAD',
  'HTTP_ERROR_RATE',
  'HTTP_AVG_RESPONSE_TIME',
]);

const QUERY_POLICIES = /* GraphQL */ `
  query queryContinuousProfilingPolicies($serviceId: ID!) {
    targets: queryContinuousProfilingServiceTargets(serviceId: $serviceId) {
      type
      triggeredCount
      lastTriggerTimestamp
      checkItems {
        type
        threshold
        period
        count
        uriList
        uriRegex
      }
    }
  }
`;

// Processes advertising SUPPORT_EBPF_PROFILING over a rolling 10 minutes — a
// WARNING signal only, since a policy may be armed before the agent exists.
const QUERY_EBPF_READY = /* GraphQL */ `
  query queryContinuousProfilingReadiness($serviceId: ID!) {
    prepare: queryPrepareCreateEBPFProfilingTaskData(serviceId: $serviceId) {
      couldProfiling
    }
  }
`;

const SET_POLICY = /* GraphQL */ `
  mutation setContinuousProfilingPolicy($request: ContinuousProfilingPolicyCreation!) {
    result: setContinuousProfilingPolicy(request: $request) {
      status
      errorReason
    }
  }
`;

const QUERY_INSTANCES = /* GraphQL */ `
  query queryContinuousProfilingMonitoringInstances($serviceId: ID!, $target: ContinuousProfilingTargetType!) {
    instances: queryContinuousProfilingMonitoringInstances(serviceId: $serviceId, target: $target) {
      id
      name
      triggeredCount
      lastTriggerTimestamp
      processes {
        id
        name
        detectType
        labels
        triggeredCount
        lastTriggerTimestamp
      }
    }
  }
`;

function softErr<T extends { reachable: boolean; error?: string }>(payload: T, err: unknown): T {
  payload.reachable = false;
  payload.error = err instanceof Error ? err.message : String(err);
  return payload;
}

/** The mutation input's shape for one target. NOT the read shape: OAP names the
 *  field `targetType` on `ContinuousProfilingPolicyTargetCreation` but `type` on
 *  the `ContinuousProfilingPolicyTarget` it returns. Sending the read shape back
 *  fails with "field name 'type' that is not defined for input object type". */
interface PolicyTargetInput {
  targetType: ContinuousProfilingTargetType;
  checkItems: ContinuousProfilingPolicyItem[];
}

/** Strip a policy to what the mutation input accepts and rename `type` →
 *  `targetType`. `triggeredCount` / `lastTriggerTimestamp` are OUTPUT-only;
 *  forwarding them fails the whole write on an unknown field. */
/** Percentage monitors OAP bounds at 100; the rest it only requires above zero.
 *  `validatePolicyItem` in `ContinuousProfilingMutationService`. */
const THRESHOLD_MAX: Partial<Record<ContinuousProfilingMonitorType, number>> = {
  PROCESS_CPU: 100,
  HTTP_ERROR_RATE: 100,
};

/**
 * Why OAP would refuse this threshold, or `null`.
 *
 * Mirrors OAP's `validatePolicyItem`, which `Integer.parseInt`s ALL FIVE monitor
 * types — including the three Rover would `ParseFloat`, since the value never
 * reaches Rover. The UI checks the same rule at the field; this is the API
 * boundary and must not depend on it.
 */
function thresholdError(type: ContinuousProfilingMonitorType, raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'threshold is required';
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return 'threshold must be a whole number (OAP parses every monitor type as an integer)';
  const n = Number(text);
  if (n <= 0) return 'threshold must be greater than 0';
  const max = THRESHOLD_MAX[type];
  if (max !== undefined && n > max) return `threshold must be 1..${max}`;
  return null;
}

function sanitiseTargets(raw: unknown): { targets: PolicyTargetInput[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'targets must be an array' };
  const targets: PolicyTargetInput[] = [];
  for (const t of raw as ContinuousProfilingPolicyTarget[]) {
    if (!t || !VALID_TARGETS.has(t.type)) {
      return { error: `target type must be one of ${[...VALID_TARGETS].join(', ')}` };
    }
    if (!Array.isArray(t.checkItems) || !t.checkItems.length) {
      return { error: `target ${t.type} needs at least one check item` };
    }
    const checkItems: ContinuousProfilingPolicyItem[] = [];
    for (const it of t.checkItems) {
      if (!it || !VALID_MONITORS.has(it.type)) {
        return { error: `monitor type must be one of ${[...VALID_MONITORS].join(', ')}` };
      }
      const thresholdBad = thresholdError(it.type, it.threshold);
      if (thresholdBad) return { error: `${it.type}: ${thresholdBad}` };
      // Rounded, these silently save a value the operator never typed — 1.5
      // becomes 2 — which is the same silent repair this whole change removes.
      if (!Number.isInteger(it.period) || it.period <= 0) {
        return { error: `${it.type}: period must be a whole number of seconds greater than 0` };
      }
      if (!Number.isInteger(it.count) || it.count <= 0) {
        return { error: `${it.type}: count must be a whole number greater than 0` };
      }
      // OAP: "count must be equal to or smaller than period".
      if (it.count > it.period) {
        return { error: `${it.type}: count must be equal to or smaller than period` };
      }
      const uriList = Array.isArray(it.uriList) ? it.uriList.filter((u) => typeof u === 'string' && u) : [];
      const uriRegex = typeof it.uriRegex === 'string' && it.uriRegex ? it.uriRegex : '';
      // NOT an OAP rule: `validatePolicyItem` ignores both fields and Rover
      // takes the list. Ours, because a policy carrying both silently filters on
      // a dimension nobody chose — so the message must name the way out.
      if (uriList.length && uriRegex) {
        return {
          error: `${it.type}: this rule carries both a URI list and a URI regex. Nothing rejects that upstream, but the eBPF agent applies the LIST and ignores the regex — pick one on the rule and apply again.`,
        };
      }
      checkItems.push({
        type: it.type,
        threshold: it.threshold.trim(),
        period: it.period,
        count: it.count,
        ...(uriList.length ? { uriList } : {}),
        ...(uriRegex ? { uriRegex } : {}),
      });
    }
    targets.push({ targetType: t.type, checkItems });
  }
  return { targets };
}

export function registerContinuousProfilingRoutes(
  app: FastifyInstance,
  deps: ContinuousProfilingRouteDeps,
): void {
  const auth = requireAuth(deps);
  const catalog = serviceLayerCatalog({ config: deps.config, fetch: deps.fetch });

  /**
   * `GET /api/continuous-profiling/policy-summary?layer=KEY` — which targets
   * each service of a layer has armed.
   *
   * Lets the service picker say "songs · ON_CPU, NETWORK" / "rating · no
   * policy" instead of listing bare names, which is the difference between
   * choosing a service and guessing at one. The per-service fan-out OAP forces
   * on us lives in `logic/oap/continuous-profiling.ts`.
   */
  app.get(
    '/api/continuous-profiling/policy-summary',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as { layer?: string };
      const payload: {
        services: Array<{ id: string; name: string; targets: ContinuousProfilingTargetType[] | null }>;
        checked: number;
        total: number;
        reachable: boolean;
        error?: string;
      } = { services: [], checked: 0, total: 0, reachable: true };
      if (!q.layer) {
        payload.error = 'missing layer';
        return reply.send(payload);
      }
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const snap = await catalog.get();
        const summary = await policySummaryForServices(opts, snap.byLayer.get(q.layer.toUpperCase()) ?? []);
        payload.services = summary.rows;
        payload.checked = summary.checked;
        payload.total = summary.total;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );

  app.get(
    '/api/continuous-profiling/policies',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as { service?: string };
      const payload: ContinuousProfilingPoliciesResponse = { targets: [], reachable: true };
      if (!q.service) {
        payload.error = 'missing service';
        return reply.send(payload);
      }
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        // The readiness probe is advisory, so a failure there must not lose the
        // policy — the page can warn about an unknown agent state, but it
        // cannot edit rules it never received.
        const [data, ready] = await Promise.all([
          graphqlPost<{ targets: ContinuousProfilingPolicyTarget[] }>(opts, QUERY_POLICIES, {
            serviceId: q.service,
          }),
          graphqlPost<{ prepare: { couldProfiling: boolean } }>(opts, QUERY_EBPF_READY, {
            serviceId: q.service,
          }).catch(() => null),
        ]);
        payload.targets = data.targets ?? [];
        payload.ebpfReporting = ready ? (ready.prepare?.couldProfiling ?? false) : null;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );

  app.post(
    '/api/continuous-profiling/policies',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const raw = (req.body ?? {}) as Partial<ContinuousProfilingPolicyRequest>;
      const payload: ContinuousProfilingSetResponse = { status: false, reachable: true };
      if (typeof raw.serviceId !== 'string' || !raw.serviceId) {
        payload.errorReason = 'missing serviceId';
        return reply.send(payload);
      }
      const sanitised = sanitiseTargets(raw.targets);
      if ('error' in sanitised) {
        payload.errorReason = sanitised.error;
        return reply.send(payload);
      }
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{ result: { status: boolean; errorReason?: string | null } }>(
          opts,
          SET_POLICY,
          { request: { serviceId: raw.serviceId, targets: sanitised.targets } },
        );
        payload.status = data.result?.status ?? false;
        payload.errorReason = data.result?.errorReason ?? null;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );

  app.get(
    '/api/continuous-profiling/instances',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as { service?: string; targets?: string };
      const empty = { instanceCount: 0, processCount: 0, triggeredInstanceCount: 0 };
      const payload: ContinuousProfilingInstancesResponse = {
        instances: [], targets: [], summary: empty, reachable: true,
      };
      if (!q.service) {
        payload.error = 'missing service';
        return reply.send(payload);
      }
      const targets = (q.targets ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!targets.length || targets.some((t) => !VALID_TARGETS.has(t))) {
        payload.error = `targets must be a comma-separated subset of ${[...VALID_TARGETS].join(', ')}`;
        return reply.send(payload);
      }
      const wanted = [...new Set(targets)] as ContinuousProfilingTargetType[];
      payload.targets = wanted;
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        // OAP's query takes ONE target and rebuilds the whole instance/process
        // list for each (listProcesses/getInstances take no target — only the
        // trigger summary varies), so N targets means N identical rosters on
        // the wire. Fan out here and keep ONE copy, attaching counts per
        // target: at 100 instances that is the difference between ~400 KB and
        // ~130 KB reaching the browser, and between 3 rosters and 1 in the DOM.
        const perTarget = await Promise.all(
          wanted.map((target) =>
            graphqlPost<{ instances: WireInstance[] }>(opts, QUERY_INSTANCES, {
              serviceId: q.service,
              target,
            }).then((d) => ({ target, instances: d.instances ?? [] })),
          ),
        );
        const byId = new Map<string, ContinuousProfilingInstancesResponse['instances'][number]>();
        for (const { target, instances } of perTarget) {
          for (const inst of instances) {
            let row = byId.get(inst.id);
            if (!row) {
              row = {
                id: inst.id,
                name: inst.name,
                triggers: {},
                processes: inst.processes.map((p) => ({
                  id: p.id, name: p.name, detectType: p.detectType, labels: p.labels ?? [], triggers: {},
                })),
              };
              byId.set(inst.id, row);
            }
            row.triggers[target] = { count: inst.triggeredCount ?? 0, last: inst.lastTriggerTimestamp ?? null };
            const procById = new Map(row.processes.map((p) => [p.id, p]));
            for (const p of inst.processes) {
              const seen = procById.get(p.id);
              if (seen) seen.triggers[target] = { count: p.triggeredCount ?? 0, last: p.lastTriggerTimestamp ?? null };
            }
          }
        }
        const rows = [...byId.values()];
        payload.instances = rows;
        payload.summary = {
          instanceCount: rows.length,
          processCount: rows.reduce((n, r) => n + r.processes.length, 0),
          triggeredInstanceCount: rows.filter((r) =>
            Object.values(r.triggers).some((v) => (v?.count ?? 0) > 0),
          ).length,
        };
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );
}
