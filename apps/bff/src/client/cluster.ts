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
 * Runtime-rule cluster snapshot.
 *
 * The BFF fires a single `/runtime/rule/list` to `oap.adminUrl` and
 * exposes the result. OAP routes rule operations cluster-internally, so
 * one node's list is the cluster's list — we don't fan out on the BFF
 * side.
 */

import type {
  Catalog,
  ListEnvelope,
  ListRow,
  LocalState,
  RuleStatus,
} from '@skywalking-horizon-ui/api-client';
import type { OapClients } from './index.js';

export interface ClusterRuleRow {
  catalog: Catalog;
  name: string;
  status: RuleStatus | null;
  localState: LocalState | null;
  contentHash: string | null;
  lastApplyError: string;
}

export interface ClusterStateResponse {
  generatedAt: number;
  /** The admin URL the BFF fired against. The response is the cluster's
   *  rule list — OAP itself handles inter-node routing. */
  adminUrl: string;
  /** True iff the list call succeeded. */
  ok: boolean;
  /** Populated when `ok === false`. */
  error?: string;
  rules: ClusterRuleRow[];
}

export async function fetchClusterState(clients: OapClients): Promise<ClusterStateResponse> {
  const adminUrl = clients.adminUrl();
  const generatedAt = Date.now();
  let envelope: ListEnvelope;
  try {
    envelope = await clients.primary().list();
  } catch (err) {
    return {
      generatedAt,
      adminUrl,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      rules: [],
    };
  }
  return {
    generatedAt,
    adminUrl,
    ok: true,
    rules: envelope.rules.map((rule) => ({
      catalog: rule.catalog,
      name: rule.name,
      status: rule.status,
      localState: rule.localState,
      contentHash: rule.contentHash,
      lastApplyError: extractLastApplyError(rule),
    })),
  };
}

function extractLastApplyError(row: ListRow): string {
  return 'lastApplyError' in row ? row.lastApplyError : '';
}
