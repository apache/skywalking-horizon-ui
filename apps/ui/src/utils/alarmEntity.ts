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
 * Pretty-print an alarm's entity identity from its raw OAP `scope` +
 * `name` fields.
 *
 * OAP's `NotifyHandler` already pre-formats the human piece into the
 * `name` field (e.g. `serviceA to serviceB` for ServiceRelation,
 * `instX of svcY` for ServiceInstance) — see
 * skywalking/oap-server/.../alarm/provider/NotifyHandler.java.
 *
 * The UI does two things on top:
 *  1. Prefix with the scope-as-noun ("Service", "Relation
 *     Service→Service", …) so the raw enum + base64 entity ID never
 *     appear.
 *  2. Pull SkyWalking's `<group>::<base>` convention out of every
 *     name token in the body — `agent::app to cart::api` becomes
 *     `[AGENT] app to [CART] api`, with each `<group>::` rendered as
 *     a small chip via the `kind: 'group'` segment.
 */

import type { AlarmScope } from '@/api/client';

export interface AlarmEntityLabel {
  /** Scope rendered as a noun + relation arrows. Empty string for
   *  unknown scopes (UI can fall back to body-only). */
  prefix: string;
  /** Token sequence for the body. Render `group` segments as a small
   *  chip-and-name pair, `text` segments verbatim. */
  segments: AlarmEntitySegment[];
}

export type AlarmEntitySegment =
  | { kind: 'group'; group: string; base: string }
  | { kind: 'text'; text: string };

const PREFIX_BY_SCOPE: Record<string, string> = {
  Service: 'Service',
  ServiceInstance: 'Instance',
  Endpoint: 'Endpoint',
  Process: 'Process',
  ServiceRelation: 'Relation Service→Service',
  ServiceInstanceRelation: 'Relation Instance→Instance',
  EndpointRelation: 'Relation Endpoint→Endpoint',
  ProcessRelation: 'Relation Process→Process',
  All: 'All',
};

/* `<group>::<base>` matcher. Greedy on the group (everything up to
 * `::`), bounded on the base by whitespace or the relation/instance
 * separators OAP uses (`of`, `to`, `in`). Built with a `\b` boundary
 * on the right so a trailing `.<namespace>` stays in the base. */
const GROUP_RE = /([A-Za-z0-9_\-]+)::([^\s]+)/g;

export function splitEntityBody(body: string): AlarmEntitySegment[] {
  const out: AlarmEntitySegment[] = [];
  let cursor = 0;
  GROUP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GROUP_RE.exec(body)) !== null) {
    if (m.index > cursor) {
      out.push({ kind: 'text', text: body.slice(cursor, m.index) });
    }
    out.push({ kind: 'group', group: m[1]!, base: m[2]! });
    cursor = m.index + m[0]!.length;
  }
  if (cursor < body.length) {
    out.push({ kind: 'text', text: body.slice(cursor) });
  }
  /* Bodies with no `::` at all collapse to a single text segment so
   * the UI can render the same way regardless. */
  if (out.length === 0) out.push({ kind: 'text', text: body });
  return out;
}

export function formatAlarmEntity(
  scope: AlarmScope | string | null | undefined,
  name: string,
): AlarmEntityLabel {
  const key = typeof scope === 'string' ? scope : '';
  const prefix = PREFIX_BY_SCOPE[key] ?? '';
  return { prefix, segments: splitEntityBody(name) };
}
