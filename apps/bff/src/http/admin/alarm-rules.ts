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
 * `/api/admin/alarm-rules*` — read-only views into OAP's alarm-rule
 * catalog. Backed by `/status/alarm/*` on the OAP admin port.
 *
 *   GET /api/admin/alarm-rules         — list every loaded rule with
 *                                        its body merged in (one
 *                                        round-trip per rule, runs
 *                                        in parallel).
 *   GET /api/admin/alarm-rules/:id     — full detail for one rule.
 *   GET /api/admin/alarm-rules/:id/context?entity=…
 *                                      — running window for one entity
 *                                        (the metric snapshot the rule
 *                                        is evaluating right now).
 *
 * Read-only. The OAP alarm-rule lifecycle is "edit the YAML, restart
 * (or let the watcher pick up the change)"; no mutation surface
 * exists upstream and we don't fabricate one.
 *
 * Both routes invert the upstream `ClusterAlarmStatus` envelope into
 * a flatter wire shape that's easier to render: the per-node load
 * state is pivoted into a `nodes[]` array per rule so the UI sees
 * "rule X is loaded on 2/3 nodes" at a glance.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AlarmRuleDetail,
  AlarmRunningContext,
  AlarmStatusClient,
  ClusterAlarmStatus,
  FetchLike,
  InstanceAlarmStatus,
} from '@skywalking-horizon-ui/api-client';
import { AlarmStatusApiError } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { buildOapClients } from '../../client/index.js';

export interface AlarmRulesRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

export interface AlertingRuleNode {
  /** OAP-node address (gRPC `host:port` or `Self()` literal). */
  address: string;
  /** True iff the node responded with a successful list payload. */
  ok: boolean;
  /** Per-node failure reason. Null when `ok`. */
  error?: string;
  /** True when the rule appeared in this node's `ruleList`. False
   *  signals the rule isn't loaded on this node (config drift). */
  loaded: boolean;
}

export interface AlertingRuleSummary {
  ruleId: string;
  /** Best-effort detail body, when at least one node returned it.
   *  Null when every node failed or the rule wasn't found. */
  detail: AlarmRuleDetail | null;
  /** Per-node load state. */
  nodes: AlertingRuleNode[];
  /** Quick stats — how many nodes loaded this rule. */
  loadedOn: number;
  totalNodes: number;
}

export interface AlertingRulesListResponse {
  generatedAt: number;
  /** Whole-cluster reachability — true iff at least one node
   *  responded to `/status/alarm/rules`. */
  reachable: boolean;
  /** Top-level error when no node responded. */
  error?: string;
  rules: AlertingRuleSummary[];
  /** Per-node fetch result for the initial /rules call — exposes
   *  partial-failure cases to the UI. */
  nodes: Array<{ address: string; ok: boolean; error?: string }>;
}

export interface AlertingRuleDetailResponse {
  ruleId: string;
  generatedAt: number;
  reachable: boolean;
  error?: string;
  /** Detail body picked from the first node that returned one. */
  detail: AlarmRuleDetail | null;
  /** Per-node detail snapshot — operators occasionally need to see
   *  the rule diverge across nodes (mid-rollout). */
  nodes: Array<{
    address: string;
    ok: boolean;
    error?: string;
    detail: AlarmRuleDetail | null;
  }>;
}

export interface AlertingRuleContextNode {
  address: string;
  ok: boolean;
  error?: string;
  /** Running window for this entity on this node. Null on a node that
   *  isn't evaluating the entity (or that failed). */
  context: AlarmRunningContext | null;
}

export interface AlertingRuleContextResponse {
  ruleId: string;
  entityName: string;
  generatedAt: number;
  reachable: boolean;
  error?: string;
  /** Per-node running context. Only the node evaluating the entity
   *  carries a populated body; the rest are stubs. */
  nodes: AlertingRuleContextNode[];
}

/* Pivot a per-rule x per-node matrix from the two-step fan-out. */
function pivot(
  listResp: ClusterAlarmStatus<{ ruleList: Array<{ id: string }> }>,
  detailById: Map<string, ClusterAlarmStatus<AlarmRuleDetail> | Error>,
): Pick<AlertingRulesListResponse, 'rules' | 'nodes'> {
  const nodes = listResp.oapInstances.map((i) => ({
    address: i.address,
    ok: !i.errorMsg && !!i.status,
    error: i.errorMsg ?? undefined,
  }));
  const totalNodes = nodes.length || 1;

  const perRuleNodes = new Map<string, Set<string>>();
  for (const inst of listResp.oapInstances) {
    if (!inst.status) continue;
    for (const r of inst.status.ruleList ?? []) {
      let set = perRuleNodes.get(r.id);
      if (!set) {
        set = new Set();
        perRuleNodes.set(r.id, set);
      }
      set.add(inst.address);
    }
  }

  const rules: AlertingRuleSummary[] = [];
  for (const [ruleId, loadedAddrs] of perRuleNodes) {
    const detailEnvOrErr = detailById.get(ruleId);
    let bestDetail: AlarmRuleDetail | null = null;
    if (detailEnvOrErr && !(detailEnvOrErr instanceof Error)) {
      for (const inst of detailEnvOrErr.oapInstances) {
        if (inst.status) {
          bestDetail = inst.status;
          break;
        }
      }
    }
    rules.push({
      ruleId,
      detail: bestDetail,
      nodes: listResp.oapInstances.map((i) => ({
        address: i.address,
        ok: !i.errorMsg && !!i.status,
        error: i.errorMsg ?? undefined,
        loaded: loadedAddrs.has(i.address),
      })),
      loadedOn: loadedAddrs.size,
      totalNodes,
    });
  }
  rules.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  return { rules, nodes };
}

export function registerAlarmRulesRoutes(
  app: FastifyInstance,
  deps: AlarmRulesRouteDeps,
): void {
  const auth = requireAuth(deps);

  function client(): AlarmStatusClient {
    return buildOapClients(deps.config.current, { fetch: deps.fetch }).alarmStatus();
  }

  app.get(
    '/api/admin/alarm-rules',
    { preHandler: auth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const c = client();
      let listResp: ClusterAlarmStatus<{ ruleList: Array<{ id: string }> }>;
      try {
        listResp = await c.listRules();
      } catch (err) {
        return reply.send({
          generatedAt: Date.now(),
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
          rules: [],
          nodes: [],
        } satisfies AlertingRulesListResponse);
      }

      /* Collect every unique rule id, then fetch detail bodies in
       * parallel. Bounded concurrency isn't strictly needed (a
       * typical install has ≤30 rules), but we run them concurrently
       * so total wall-time is one detail-roundtrip + the list. */
      const ids = new Set<string>();
      for (const inst of listResp.oapInstances) {
        for (const r of inst.status?.ruleList ?? []) ids.add(r.id);
      }
      const detailById = new Map<string, ClusterAlarmStatus<AlarmRuleDetail> | Error>();
      await Promise.all(
        Array.from(ids).map(async (id) => {
          try {
            const env = await c.ruleDetail(id);
            detailById.set(id, env);
          } catch (err) {
            detailById.set(id, err instanceof Error ? err : new Error(String(err)));
          }
        }),
      );

      const { rules, nodes } = pivot(listResp, detailById);
      const body: AlertingRulesListResponse = {
        generatedAt: Date.now(),
        reachable: nodes.some((n) => n.ok),
        rules,
        nodes,
      };
      return reply.send(body);
    },
  );

  app.get(
    '/api/admin/alarm-rules/:id',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const id = (req.params as { id?: string }).id;
      if (!id) return reply.code(400).send({ error: 'missing_id' });
      const c = client();
      let env: ClusterAlarmStatus<AlarmRuleDetail>;
      try {
        env = await c.ruleDetail(id);
      } catch (err) {
        const status =
          err instanceof AlarmStatusApiError && err.status === 404 ? 404 : 502;
        return reply.code(status).send({
          ruleId: id,
          generatedAt: Date.now(),
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
          detail: null,
          nodes: [],
        });
      }
      const perNode = env.oapInstances.map<{
        address: string;
        ok: boolean;
        error?: string;
        detail: AlarmRuleDetail | null;
      }>((i: InstanceAlarmStatus<AlarmRuleDetail>) => ({
        address: i.address,
        ok: !i.errorMsg && !!i.status,
        error: i.errorMsg ?? undefined,
        detail: i.status ?? null,
      }));
      const detail = perNode.find((n) => n.detail !== null)?.detail ?? null;
      const body: AlertingRuleDetailResponse = {
        ruleId: id,
        generatedAt: Date.now(),
        reachable: perNode.some((n) => n.ok),
        detail,
        nodes: perNode,
      };
      return reply.send(body);
    },
  );

  // `entity` rides as a query param (not a path segment) because entity
  // names carry `::` and may carry `/` (endpoint scope) — path-segment
  // encoding of those is a portability minefield across proxies.
  app.get(
    '/api/admin/alarm-rules/:id/context',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const id = (req.params as { id?: string }).id;
      const entity = (req.query as { entity?: string }).entity;
      if (!id) return reply.code(400).send({ error: 'missing_id' });
      if (!entity) return reply.code(400).send({ error: 'missing_entity' });
      const c = client();
      let env: ClusterAlarmStatus<AlarmRunningContext>;
      try {
        env = await c.ruleContext(id, entity);
      } catch (err) {
        const status =
          err instanceof AlarmStatusApiError && err.status === 404 ? 404 : 502;
        return reply.code(status).send({
          ruleId: id,
          entityName: entity,
          generatedAt: Date.now(),
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
          nodes: [],
        } satisfies AlertingRuleContextResponse);
      }
      const nodes = env.oapInstances.map<AlertingRuleContextNode>(
        (i: InstanceAlarmStatus<AlarmRunningContext>) => ({
          address: i.address,
          ok: !i.errorMsg && !!i.status,
          error: i.errorMsg ?? undefined,
          context: i.status ?? null,
        }),
      );
      const body: AlertingRuleContextResponse = {
        ruleId: id,
        entityName: entity,
        generatedAt: Date.now(),
        reachable: nodes.some((n) => n.ok),
        nodes,
      };
      return reply.send(body);
    },
  );
}
