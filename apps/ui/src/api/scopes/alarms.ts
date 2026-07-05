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

import type {
  AlarmsCountResponse,
  AlarmsQuery,
  AlarmsResponse,
  AlertingRuleContextResponse,
  AlertingRuleDetailResponse,
  AlertingRulesListResponse,
  BffClient,
} from '../client';
import { normalizeAlarmsConfig, type AlarmsConfig } from '../alarmsConfig';

/** `bff.alarms` — alarm list + topbar count probe + alarm-page
 *  config CRUD. */
export class AlarmsApi {
  constructor(private readonly bff: BffClient) {}

  list(q: AlarmsQuery): Promise<AlarmsResponse> {
    const p = new URLSearchParams({
      startTime: String(q.startTime),
      endTime: String(q.endTime),
      pageNum: String(q.pageNum ?? 1),
      pageSize: String(q.pageSize ?? 500),
    });
    if (q.scope) p.set('scope', q.scope);
    if (q.keyword) p.set('keyword', q.keyword);
    if (q.layer) p.set('layer', q.layer);
    if (q.service) p.set('service', q.service);
    if (q.instance) p.set('instance', q.instance);
    if (q.endpoint) p.set('endpoint', q.endpoint);
    return this.bff.request<AlarmsResponse>('GET', `/api/alarms?${p.toString()}`);
  }

  /** Lightweight count probe for the topbar badge — bounded selection
   *  set (id + recoveryTime only), capped result. Polled on the
   *  badge's own interval, independent of the global time-range
   *  ticker. */
  count(startTime: number, endTime: number): Promise<AlarmsCountResponse> {
    const p = new URLSearchParams({ startTime: String(startTime), endTime: String(endTime) });
    return this.bff.request<AlarmsCountResponse>('GET', `/api/alarms/count?${p.toString()}`);
  }

  /** Service roster for one OAP layer (alpha-sorted) — feeds the
   *  alarms page's cascading filter. */
  services(layer: string): Promise<{
    layer: string;
    services: Array<{ name: string; normal: boolean | null }>;
  }> {
    const p = new URLSearchParams({ layer });
    return this.bff.request('GET', `/api/alarms/services?${p.toString()}`);
  }

  /** The alarms page-setup — the `horizon.alert.page-setup` singleton template.
   *  Read its effective (OAP-remote ↔ bundled) copy from the config bundle's
   *  sync status, like the theme / time-defaults singletons; there is no local
   *  BFF store. Edits are saved to OAP via `bff.templateSync.save`. */
  config(): Promise<AlarmsConfig> {
    return this.bff.templateSync.syncStatus().then((status) => {
      const row = status.rows.find((r) => r.name === 'horizon.alert.page-setup');
      const source =
        row?.effective === 'remote' && row.remote
          ? row.remote.configuration
          : row?.bundled?.configuration;
      return normalizeAlarmsConfig(source);
    });
  }

  /** OAP `/status/alarm/rules` fan-out + per-rule detail merge.
   *  Drives the Operate › Alerting Rules page. */
  adminRules(): Promise<AlertingRulesListResponse> {
    return this.bff.request<AlertingRulesListResponse>('GET', '/api/admin/alarm-rules');
  }

  /** Single-rule detail — used by the alarms detail panel kicker
   *  AND the operate page's right pane. */
  adminRule(id: string): Promise<AlertingRuleDetailResponse> {
    return this.bff.request<AlertingRuleDetailResponse>(
      'GET',
      `/api/admin/alarm-rules/${encodeURIComponent(id)}`,
    );
  }

  /** Per-entity running window — the metric snapshot the rule is
   *  evaluating for one entity right now, per OAP node. Drives the
   *  alerting-rules row-click popup. */
  adminRuleContext(id: string, entityName: string): Promise<AlertingRuleContextResponse> {
    const p = new URLSearchParams({ entity: entityName });
    return this.bff.request<AlertingRuleContextResponse>(
      'GET',
      `/api/admin/alarm-rules/${encodeURIComponent(id)}/context?${p.toString()}`,
    );
  }
}
