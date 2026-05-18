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

import type { ClusterNode, ClusterNodesResponse } from './types.js';
import type { FetchLike } from './runtime-rule.js';

export interface StatusClientOptions {
  /** OAP query host URL (serves GraphQL + `/status/*`), default port
   *  12800. No trailing slash. Named `queryUrl` because the same OAP
   *  HTTP server hosts both the query (GraphQL) and status surfaces;
   *  StatusClient just hits the `/status/*` subset. */
  queryUrl: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
  /** Per-call timeout in ms. 0 disables. Default 0. */
  timeoutMs?: number;
}

/** Cluster node with both wire spellings of the self-flag normalised
 *  into a single `self: boolean` field. */
export interface NormalisedClusterNode {
  host: string;
  port: number;
  self: boolean;
}

/**
 * Read-only client for the upstream `/status/*` plugin endpoints v1
 * needs. Today this is a single endpoint — cluster member discovery
 * for the BFF's per-rule × per-node fan-out.
 */
export class StatusClient {
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: StatusClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.base = options.queryUrl.replace(/\/$/, '');
    this.defaultHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 0;
  }

  /** `GET /status/cluster/nodes` — returns the OAP cluster member list. */
  async clusterNodes(): Promise<NormalisedClusterNode[]> {
    const url = `${this.base}/status/cluster/nodes`;
    const init: RequestInit = {
      method: 'GET',
      headers: { Accept: 'application/json', ...this.defaultHeaders },
    };
    let res: Response;
    if (this.timeoutMs > 0) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    } else {
      res = await this.fetchImpl(url, init);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`StatusClient.clusterNodes: ${res.status} on ${url} — ${body}`);
    }
    const json = (await res.json()) as ClusterNodesResponse;
    return (json.nodes ?? []).map(normaliseNode);
  }
}

function normaliseNode(n: ClusterNode): NormalisedClusterNode {
  return {
    host: n.host,
    port: n.port,
    self: n.self ?? n.isSelf ?? false,
  };
}
