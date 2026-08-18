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
 * Sign-in attempts that are still in flight.
 *
 * The browser holds an opaque HANDLE, never the attempt itself. That is the
 * whole point: the attempt carries the CSRF state, the PKCE verifier, the nonce
 * and where to land afterwards, and a browser cookie is not a place to keep any
 * of them. `httpOnly` stops a script READING a cookie; it does nothing to stop
 * one being WRITTEN — a sibling subdomain can set a cookie on the parent domain
 * that this host will then send. With the attempt in the cookie, that let an
 * attacker plant a whole flow of their own: their state, so the callback's
 * comparison passed; their code, so the session created in the victim's browser
 * was the ATTACKER'S account; and their `next`, which had never been through
 * the same-origin check because it never went through `/start`.
 *
 * Holding the attempt here makes every one of those unreachable. An unknown
 * handle resolves to nothing and the sign-in is refused, so there is no forged
 * value to act on.
 *
 * Per-process and in memory, like the session store beside it. A restart drops
 * attempts that are mid-flight, which costs a person one click on a sign-in
 * that takes seconds; nothing durable lives here.
 */

import { randomBytes } from 'node:crypto';

export interface Flow {
  provider: string;
  state: string;
  nonce: string;
  verifier: string;
  /** Where to land in the SPA afterwards. Same-origin PATH only. */
  next: string;
}

function handle(): string {
  return randomBytes(24).toString('base64url');
}

export class FlowStore {
  private readonly flows = new Map<string, { flow: Flow; at: number }>();

  constructor(private readonly ttlMs: number) {}

  /** Keep an attempt, and return the handle the browser will carry. */
  put(flow: Flow): string {
    this.sweep();
    const id = handle();
    this.flows.set(id, { flow, at: Date.now() });
    return id;
  }

  /**
   * Resolve a handle, consuming it. SINGLE USE — a callback that arrives twice
   * is a replay, and the second one has nothing to act on.
   */
  take(id: string | undefined): Flow | null {
    if (!id) return null;
    const hit = this.flows.get(id);
    if (!hit) return null;
    this.flows.delete(id);
    return Date.now() - hit.at > this.ttlMs ? null : hit.flow;
  }

  /** Swept on write rather than on a timer: an abandoned sign-in is the common
   *  case (someone closes the provider's page), and a timer to collect a
   *  handful of small entries would outweigh what it reclaims. */
  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, v] of this.flows) if (v.at < cutoff) this.flows.delete(id);
  }

  /** Tests only. */
  get size(): number {
    return this.flows.size;
  }
}
