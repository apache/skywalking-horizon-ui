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
 * Trace pairing debugging client — the OAP `trace-pairing-debugging` module's `/trace-pairing-debugging/*` routes,
 * OAP 11.2 and later. Not a DSL debug session: it captures, on demand, the backend task that pairs an OTLP call's
 * caller and callee halves on the node that owns the trace. One capture per OAP node, shared by every reader, no
 * sessions; it runs while it is read, and stops a minute after the latest read.
 */

import { RuntimeRuleApiError, parseApiErrorBody } from './types.js';
import type { FetchLike } from './runtime-rule.js';

/** What became of a matched call: the alias pushed, or why none was. */
export type PairingOutcome = 'registered' | 'gateway' | 'uncomposed' | 'tooLong' | 'noService' | 'composed';

/** A stop, or the expiry a minute after the latest read, releases what the capture found: OAP then reads `off`. */
export type PairingCaptureState = 'off' | 'capturing';

/** A node's capture. */
export interface PairingCaptureStatus {
  state: PairingCaptureState;
  /** The round it runs: one capture from a start to its stop, shared by every node the start reached; empty while
   *  off. A read is of one round, and sums only the nodes in it. */
  roundId: string;
  startTime: number;
  lastReadTime: number;
  /** How long it runs after the latest read. */
  idleMillis: number;
}

export interface PairingNode {
  /** The node's admin address, as OAP's cluster lists it; none when the cluster registry does not list that node. */
  peer?: string;
  nodeId?: string;
  status: 'ok' | 'unreachable';
  /** Start and stop: the node's capture. */
  capture?: PairingCaptureStatus;
  /** A read: the node's capture state, its round, and its calls matched; a node in another round than the read's is
   *  not summed in. */
  state?: PairingCaptureState;
  roundId?: string;
  matched?: number;
  error?: string;
}

/** A peer a caller dialed, and the server it was matched to. */
export interface MatchedPeer {
  peer: string;
  /** The callee service of the latest match. */
  server: string;
  /** The server before it, when a later match, or another node, moved the peer to another. */
  previousServer?: string;
  /** When the previous server was matched last. */
  previousTime?: number;
  /** When a match moved the peer off it. */
  updatedTime?: number;
  /** The latest five callers that dialed it. */
  callers: string[];
  /** The address the latest match composed; absent when none did, as for a gateway. */
  address?: string;
  count: number;
  outcomes: Partial<Record<PairingOutcome, number>>;
  firstTime: number;
  lastTime: number;
  /** The OAP nodes that hold it, by admin address: the owners of the traces it counts, the latest first. */
  nodes?: string[];
}

/** Halves that left the buffer without their pair, by `expired`, `evicted` or `replaced`. */
interface UnmatchedEntry {
  count: number;
  causes: Record<string, number>;
  firstTime: number;
  lastTime: number;
  /** The latest five, the latest first. */
  traceIds: string[];
  /** The OAP nodes that hold it, by admin address: the owners of the traces it counts, the latest first. */
  nodes?: string[];
}

/** Caller halves of one peer. */
export interface UnmatchedPeer extends UnmatchedEntry {
  peer: string;
  callers: string[];
}

/** Callee halves of one server. */
export interface UnmatchedServer extends UnmatchedEntry {
  server: string;
  rules: string[];
}

/** What the capture found, summed over the OAP nodes, each list the most recently seen first. */
export interface PairingsResponse extends PairingCaptureStatus {
  /** Halves the nodes received, by role. */
  received: { caller?: number; callee?: number };
  /** Calls whose two halves met. */
  matched: number;
  /** Halves that left the buffer without their pair, by role and cause. */
  unmatched: { caller?: Record<string, number>; callee?: Record<string, number> };
  matchedPeers: MatchedPeer[];
  unmatchedPeers: UnmatchedPeer[];
  unmatchedServers: UnmatchedServer[];
  nodes: PairingNode[];
}

/** Start and stop: every node's capture. */
export interface PairingCaptureResponse {
  nodes: PairingNode[];
}

export interface TracePairingDebuggingClientOptions {
  adminUrl: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class TracePairingDebuggingClient {
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: TracePairingDebuggingClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.base = options.adminUrl.replace(/\/$/, '');
    this.defaultHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 0;
  }

  /** `POST /trace-pairing-debugging/start` — turn the capture on on every node, afresh where it was off. */
  async start(): Promise<PairingCaptureResponse> {
    return this.json<PairingCaptureResponse>(`${this.base}/trace-pairing-debugging/start`, { method: 'POST' });
  }

  /** `POST /trace-pairing-debugging/stop`. */
  async stop(): Promise<PairingCaptureResponse> {
    return this.json<PairingCaptureResponse>(`${this.base}/trace-pairing-debugging/stop`, { method: 'POST' });
  }

  /** `GET /trace-pairing-debugging/pairings?limit=` — a read, which keeps the capture running; `signal` cancels it,
   *  as when the reader left, so an abandoned read costs no fan-out. */
  async getPairings(limit?: number, signal?: AbortSignal): Promise<PairingsResponse> {
    const qs = limit === undefined ? '' : `?${new URLSearchParams({ limit: String(limit) }).toString()}`;
    return this.json<PairingsResponse>(`${this.base}/trace-pairing-debugging/pairings${qs}`, {
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
  }

  /** Send and read the answer, the timeout covering the body as well as the headers: a body that stalls times out
   *  like an unanswered request. The timeout joins the caller's signal, never replaces it. */
  private async json<T>(url: string, init: RequestInit): Promise<T> {
    const finalInit: RequestInit = {
      ...init,
      headers: { Accept: 'application/json', ...this.defaultHeaders, ...((init.headers as Record<string, string>) ?? {}) },
    };
    const controller = this.timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    const signal = controller
      ? (init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal)
      : init.signal;
    try {
      const res = await this.fetchImpl(url, { ...finalInit, ...(signal ? { signal } : {}) });
      if (!res.ok) throw new RuntimeRuleApiError(res.status, parseApiErrorBody(await res.text()), url);
      return (await res.json()) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
