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
 * The service identity a service-scoped query carries: `serviceId` and
 * `service` (the NAME) TOGETHER, exactly as the layer's service roster returned
 * them.
 *
 * OAP mints the id as `IDManager.ServiceID.buildId(name, layer.isNormal())` —
 * `base64(<name>).<1 normal | 0 virtual>` — so rebuilding an id from a bare
 * name means guessing that flag, and a wrong guess addresses a DIFFERENT
 * entity. Both halves are in hand the moment the service is picked, so both
 * travel with the request and nothing is resolved here: the OAP APIs that key
 * on the id (traces, logs, endpoints, instances, topology, profiling) read
 * `id`; the alarm entity filter and endpoint-scoped MQE, which have no id form,
 * read `name` (and the flag that rode along with it).
 */

/** A layer roster row's two halves, as the caller sent them back. */
export interface ServiceIdentity {
  id: string;
  /** Empty only for a caller that holds no roster row: the Explore entity form
   *  builds its own ids from the operator's entity and forwards no name. The
   *  OAP APIs that key on the NAME refuse an empty one where they need it. */
  name: string;
}

/**
 * What a request said about its service.
 *
 *  - `all`        — no service asked for; a cross-service query is legitimate.
 *  - `service`    — an identity to query with.
 *  - `incomplete` — a NAME arrived with no id. REFUSE: nothing turns it into
 *    one any more, and every id-taking OAP condition reads a missing serviceId
 *    as "all services" — the operator would get every service's records under
 *    the one name they picked.
 */
export type ServiceScope =
  | { kind: 'all' }
  | { kind: 'service'; service: ServiceIdentity }
  | { kind: 'incomplete'; message: string };

/** The identity a route received — from its query string or its JSON body;
 *  both spell the fields the same way. */
export function serviceScopeOf(q: {
  serviceId?: string | null;
  service?: string | null;
}): ServiceScope {
  const id = (q.serviceId ?? '').trim();
  const name = (q.service ?? '').trim();
  if (id) return { kind: 'service', service: { id, name } };
  if (!name) return { kind: 'all' };
  return {
    kind: 'incomplete',
    message: `Service "${name}" arrived without its serviceId. Send the id and the name together, as the service roster returned them.`,
  };
}

/** The roster row's `normal` flag, for the OAP APIs that key on the service
 *  NAME and therefore need it alongside. Strictly `true` / `false` — anything
 *  looser would coerce a typo into "normal" and query an entity id that was
 *  never stored, which OAP answers with an empty page. */
export function serviceNormalOf(raw: string | null | undefined): boolean | null {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}
