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
 * Construct OAP API clients on demand. Per-request construction is fine
 * — the clients are thin classes with no per-instance state worth
 * pooling. The factory exists so tests can inject a stub fetch and so
 * config hot-reload picks up new admin URLs without restart.
 */

import {
  AlarmStatusClient,
  DslDebuggingClient,
  InspectClient,
  OalClient,
  RuntimeRuleClient,
  StatusClient,
  UITemplateClient,
  type FetchLike,
} from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../config/schema.js';

export interface OapClients {
  /** Build a runtime-rule client for one specific admin URL — used
   *  by the cluster fan-out, which talks to every URL. */
  forUrl(adminUrl: string): RuntimeRuleClient;
  /** Convenience — runtime-rule client for the *first* admin URL,
   *  used for reads and for writes (OAP's forward-RPC handles peer
   *  convergence). */
  primary(): RuntimeRuleClient;
  /** Status / cluster-discovery client — port 12800. */
  status(): StatusClient;
  /** OAL read-only management client for the *first* admin URL.
   *  OAL listing is per-node and identical across nodes (modulo
   *  binary-version drift, which is operator deployment discipline);
   *  the BFF doesn't fan-out for the catalog browse. */
  oal(): OalClient;
  /** DSL-debugging client for the *first* admin URL. Session install
   *  and collect both fan-out internally on the OAP side; Studio
   *  hits one node and lets OAP do the cluster work. */
  debug(): DslDebuggingClient;
  /** Build a DSL-debugging client for one specific URL — used by the
   *  DNS-resolved per-IP fan-out for `/dsl-debugging/status`. */
  debugForUrl(adminUrl: string): DslDebuggingClient;
  /** Inspect API client (SWIP-14) — metadata-only catalog + entity
   *  enumeration. */
  inspect(): InspectClient;
  /** Alarm-status client — `/status/alarm/*` admin REST. OAP itself
   *  aggregates cluster-wide; one fire is enough. */
  alarmStatus(): AlarmStatusClient;
  /** UI-template REST client — `/ui-management/templates*` on the admin
   *  port. Read + write for dashboard / page-setup blobs that Horizon
   *  syncs to OAP under the `horizon.*` name prefix. */
  uiTemplate(): UITemplateClient;
  /** The configured admin URL (single). DNS-resolved on demand by
   *  features that want per-node visibility (live-debug status). */
  adminUrl(): string;
}

export interface BuildOapClientsOptions {
  fetch?: FetchLike;
}

export function buildOapClients(
  config: HorizonConfig,
  opts: BuildOapClientsOptions = {},
): OapClients {
  const fetch = opts.fetch;
  const primaryUrl = config.oap.adminUrl;
  const timeoutMs = config.oap.timeoutMs;
  // One basic-auth header shared by every constructed client, so all
  // upstream calls authenticate.
  const headers: Record<string, string> | undefined = config.oap.auth
    ? {
        authorization:
          'Basic ' +
          Buffer.from(
            `${config.oap.auth.username}:${config.oap.auth.password}`,
            'utf8',
          ).toString('base64'),
      }
    : undefined;
  return {
    forUrl(adminUrl: string): RuntimeRuleClient {
      return new RuntimeRuleClient({ adminUrl, fetch, timeoutMs, headers });
    },
    primary(): RuntimeRuleClient {
      return new RuntimeRuleClient({ adminUrl: primaryUrl, fetch, timeoutMs, headers });
    },
    status(): StatusClient {
      return new StatusClient({ queryUrl: config.oap.queryUrl, fetch, timeoutMs, headers });
    },
    oal(): OalClient {
      return new OalClient({ adminUrl: primaryUrl, fetch, timeoutMs, headers });
    },
    debug(): DslDebuggingClient {
      return new DslDebuggingClient({ adminUrl: primaryUrl, fetch, timeoutMs, headers });
    },
    debugForUrl(adminUrl: string): DslDebuggingClient {
      return new DslDebuggingClient({ adminUrl, fetch, timeoutMs, headers });
    },
    inspect(): InspectClient {
      return new InspectClient({ adminUrl: primaryUrl, fetch, timeoutMs, headers });
    },
    alarmStatus(): AlarmStatusClient {
      return new AlarmStatusClient({ adminUrl: primaryUrl, fetch, timeoutMs, headers });
    },
    uiTemplate(): UITemplateClient {
      return new UITemplateClient({ adminUrl: primaryUrl, fetch, timeoutMs, headers });
    },
    adminUrl(): string {
      return config.oap.adminUrl;
    },
  };
}
