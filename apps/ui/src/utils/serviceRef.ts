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
 * Which handle a screen holds for a service — and therefore which slot the BFF
 * request fills.
 *
 * Every entity-scoped BFF route takes `serviceId` (an OAP id, trusted as one)
 * OR `service` (a NAME, resolved against the layer roster). One ambiguous
 * argument cannot tell them apart: an OAP id is `base64(<name>).<0|1>`, a shape
 * an ordinary name can wear too (`api.1`), and a service NAME can equally be
 * some other service's id string. So the caller says which it has.
 *
 * The layer pickers select BY ID, so a screen that has a selection sends the id
 * and the query lands on exactly that entity — no name round-trip, no roster
 * lookup. Only a screen whose service really is just a name (an operator typed
 * it, a chat block was scoped by name) sends `name`, and it carries `normal`
 * when it knows it: OAP's normal (agent-detected) and virtual (conjectured)
 * services can share a name and are different entities.
 */
export type ServiceRef =
  | { kind: 'id'; id: string }
  | { kind: 'name'; name: string; normal?: boolean | null };

/** What the api façade and the picker composables accept. A bare string is a
 *  NAME — an id is never implicit, it says `kind: 'id'`. */
export type ServiceArg = ServiceRef | string;

/** A ref to a service the screen selected (or has no selection for). */
export function serviceById(id: string | null | undefined): ServiceRef | null {
  return id ? { kind: 'id', id } : null;
}

/** A ref to a service the screen only knows by name. Pass `normal` whenever it
 *  is known — without it a name shared by a normal and a virtual service is
 *  refused rather than guessed. */
export function serviceByName(
  name: string | null | undefined,
  normal?: boolean | null,
): ServiceRef | null {
  return name ? { kind: 'name', name, ...(normal === null || normal === undefined ? {} : { normal }) } : null;
}

export function toServiceRef(arg: ServiceArg | null | undefined): ServiceRef | null {
  if (!arg) return null;
  return typeof arg === 'string' ? serviceByName(arg) : arg;
}

/** The request fields that scope a query to this service. Spread into a POST
 *  body or `URLSearchParams`. `normal` rides along with a name for the routes
 *  that accept it; a route that doesn't simply ignores it. */
export function serviceRefFields(ref: ServiceRef | null): {
  serviceId?: string;
  service?: string;
  normal?: string;
} {
  if (!ref) return {};
  if (ref.kind === 'id') return { serviceId: ref.id };
  return {
    service: ref.name,
    ...(ref.normal === null || ref.normal === undefined ? {} : { normal: String(ref.normal) }),
  };
}
