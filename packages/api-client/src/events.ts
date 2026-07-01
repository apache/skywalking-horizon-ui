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
 * Wire types for the per-service events popout.
 *
 * A verbatim mirror of OAP's `queryEvents(EventQueryCondition)` shape. The BFF
 * returns the RAW event stream (newest-first); laying it out as an instance ×
 * time swimlane is the UI's concern, not the wire's. `source.service` is the
 * literal service NAME (events store + filter by name — no id resolution like
 * the logs / browser-errors feeds).
 */

/** OAP `EventType` enum, verbatim. */
export type EventType = 'Normal' | 'Error';

/** Sort order over the event timestamp (`endTime` if set, else `startTime`). */
export type EventOrder = 'ASC' | 'DES';

/** Entity scope an event was reported at. The lower levels are empty strings
 *  when the event is service- or instance-scoped. */
export interface EventSource {
  service: string;
  serviceInstance: string;
  endpoint: string;
}

/** One `Event` row. Fields mirror the GraphQL type 1:1. */
export interface EventRow {
  uuid: string;
  source: EventSource;
  name: string;
  type: EventType;
  message: string | null;
  /** Free-form key/values the reporter attached (agent OPTS, k8s reason …). */
  parameters: { key: string; value: string }[];
  /** Unix millis. `0` when the reporter never sent a `start` event. */
  startTime: number;
  /** Unix millis, or `null` when the event has not finished. */
  endTime: number | null;
  /** Layer enum name, e.g. `GENERAL`, `MESH`. */
  layer: string;
}

export interface EventsQueryRequest {
  /** Single layer enum name (UPPERCASE). Omit for all layers (global). OAP's
   *  `layer` filter is single-valued — there is no multi-layer query. */
  layer?: string;
  /** Service NAME (e.g. `agent::songs`) — passed straight to `source.service`.
   *  Only meaningful alongside a `layer`. */
  service?: string;
  serviceInstance?: string;
  endpoint?: string;
  type?: EventType;
  name?: string;
  /** Defaults to `DES` (newest-first) server-side. */
  order?: EventOrder;
  page?: number;
  pageSize?: number;
  /** Rolling window in minutes ending at "now". Ignored when an explicit
   *  `startMs` / `endMs` pair is supplied. */
  windowMinutes?: number;
  /** Absolute range as epoch millis (TZ-unambiguous). The BFF renders these
   *  into OAP-server-local time using the OAP offset — send ms, not
   *  pre-formatted local strings. */
  startMs?: number;
  endMs?: number;
}

export interface EventsResponse {
  generatedAt: number;
  query: EventsQueryRequest;
  /** OAP exposes no cross-page total for events; the BFF reports the returned
   *  row count, same as the logs / browser-errors feeds. When `total` reaches
   *  the effective `pageSize` the window is likely truncated — the UI shows a
   *  "narrow the range" hint. */
  total: number;
  /** The effective page-size cap actually used (the request clamped to
   *  `maxPageSize.events`). The UI compares `total` against this — NOT a
   *  hardcoded constant — so a sub-default cap still flips `truncated`. */
  pageSize: number;
  events: EventRow[];
  reachable: boolean;
  error?: string;
}
