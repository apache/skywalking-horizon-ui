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
 * Which graph-edge expressions read only relation metrics.
 *
 * OAP evaluates a metric under the scope of the metric, not the entity sent
 * with it: a Service metric in an edge's expression reads the SOURCE service
 * whole, whatever the destination fields say. So an edge read through its
 * destination alone may run only an expression every metric of which is a
 * relation metric (`SERVICE_RELATION`, `SERVICE_INSTANCE_RELATION`,
 * `ENDPOINT_RELATION`, `PROCESS_RELATION` in OAP's catalog). `baseline` and
 * `top_n` read by the source's name or as its parent, so they never qualify.
 */

import type { GraphqlOptions } from '../../client/graphql.js';
import { graphqlPost } from '../../client/graphql.js';

const LIST_METRICS = /* GraphQL */ `
  query HorizonMetricCatalogs {
    metrics: listMetrics { name catalog }
  }
`;

/** OAP's metric catalog is a property of the deployment; runtime rules can add
 *  metrics, so it is re-read after this long. */
const CATALOG_TTL_MS = 5 * 60_000;

let held: { at: number; catalogs: Map<string, string> } | null = null;

async function catalogs(opts: GraphqlOptions): Promise<Map<string, string>> {
  if (held && Date.now() - held.at < CATALOG_TTL_MS) return held.catalogs;
  const got = await graphqlPost<{ metrics: Array<{ name: string; catalog?: string | null }> }>(opts, LIST_METRICS, {});
  const map = new Map<string, string>();
  for (const m of got.metrics ?? []) map.set(m.name, m.catalog ?? '');
  held = { at: Date.now(), catalogs: map };
  return map;
}

export function _resetMetricScopes(): void {
  held = null;
}

const READS_BY_SOURCE = /\b(baseline|top_n)\s*\(/;

/** The identifiers of an expression that can name a metric: quoted strings
 *  and `{…}` label blocks carry values, not metric names. */
function identifiers(mqe: string): string[] {
  const bare = mqe.replace(/'[^']*'|"[^"]*"/g, ' ').replace(/\{[^}]*\}/g, ' ');
  return bare.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
}

/**
 * Of `expressions`, the ones that read relation metrics only; null when OAP's
 * catalog could not be read — an outage the caller reports, while it runs
 * none of them.
 */
export async function relationOnlyExpressions(opts: GraphqlOptions, expressions: readonly string[]): Promise<Set<string> | null> {
  const out = new Set<string>();
  if (expressions.length === 0) return out;
  let known: Map<string, string>;
  try {
    known = await catalogs(opts);
  } catch {
    return null;
  }
  for (const e of new Set(expressions)) {
    if (READS_BY_SOURCE.test(e)) continue;
    const metrics = identifiers(e).filter((id) => known.has(id));
    if (metrics.length > 0 && metrics.every((m) => known.get(m)!.endsWith('_RELATION'))) out.add(e);
  }
  return out;
}
