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
 * The identity a screen holds for a service: the OAP id AND the name, as one
 * roster row handed them over. Every service-scoped BFF request carries both.
 *
 * OAP mints the id as `base64(<name>).<1 = normal | 0 = virtual>`
 * (`IDManager.ServiceID.buildId`), so an id cannot be rebuilt from a bare name
 * without the layer's normal flag — and a wrong flag addresses a service that
 * was never stored. Carrying the pair removes that guess: the BFF spends
 * neither a lookup nor a round-trip, it just uses the half the upstream OAP API
 * takes (an id for traces / logs / instances / endpoints / topology /
 * profiling; the name — plus the flag that rode along with it — for the alarm
 * entity filter and endpoint-scoped MQE, which have no id form).
 */
export interface ServiceRef {
  id: string;
  name: string;
  /** The same row's agent-detected (`true`) / conjectured-virtual (`false`)
   *  flag. Null when the feed that supplied the name does not carry it; the
   *  routes whose OAP call is name-scoped (endpoint MQE) require it and refuse
   *  without it, and the id-scoped ones ignore it. */
  normal?: boolean | null;
}

/** The pair, or null when the screen has no service yet. Both halves are
 *  required — a half-known service is no service, never a lookup. */
export function serviceRef(
  id: string | null | undefined,
  name: string | null | undefined,
  normal?: boolean | null,
): ServiceRef | null {
  return id && name ? { id, name, normal: normal ?? null } : null;
}

/** The request fields that scope a query to this service. Spread into a POST
 *  body or `URLSearchParams`. */
export function serviceRefFields(ref: ServiceRef | null): {
  serviceId?: string;
  service?: string;
  normal?: string;
} {
  if (!ref) return {};
  return {
    serviceId: ref.id,
    service: ref.name,
    ...(ref.normal === null || ref.normal === undefined ? {} : { normal: String(ref.normal) }),
  };
}
