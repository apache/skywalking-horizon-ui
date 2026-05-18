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
 * Tracks the rolling reachability of the configured LDAP backend.
 * Drives two things:
 *   - the login page banner (the UI calls `/api/oap/info` and friends
 *     before showing the form; reachability surfaces in /api/auth/me's
 *     unauthenticated 401 envelope too — see http/user.ts).
 *   - the break-glass gate (only honored when LDAP is unhealthy).
 *
 * The probe runs lazily: every failed login refreshes it, and the
 * Auth Status page can force an immediate re-probe. We don't run a
 * background timer — a healthy directory shouldn't be hammered for
 * no reason, and a broken one shouldn't have its outage amplified.
 */

import type { LdapConfig } from '../config/schema.js';
import { probeLdap, type LdapProbeResult } from './ldap.js';

export class LdapHealth {
  private last: LdapProbeResult | null = null;
  private lastAt: number | null = null;
  /** Coalesce concurrent probes — only one in-flight at a time. */
  private inFlight: Promise<LdapProbeResult> | null = null;

  async probe(cfg: LdapConfig): Promise<LdapProbeResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = probeLdap(cfg)
      .then((r) => {
        this.last = r;
        this.lastAt = Date.now();
        return r;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Returns the cached probe result if it's still fresh, else re-probes. */
  async getOrProbe(cfg: LdapConfig, freshnessMs = 30_000): Promise<LdapProbeResult> {
    if (this.last && this.lastAt && Date.now() - this.lastAt < freshnessMs) {
      return this.last;
    }
    return this.probe(cfg);
  }

  snapshot(): { result: LdapProbeResult | null; at: number | null } {
    return { result: this.last, at: this.lastAt };
  }

  /**
   * Currently considered unhealthy if the last probe failed, or if no
   * probe has run yet. The caller (break-glass guard) should call
   * `probe()` first to make sure this reflects the current state.
   */
  isUnhealthy(): boolean {
    if (!this.last) return true;
    return !this.last.reachable || this.last.userSearchOk === false;
  }
}
