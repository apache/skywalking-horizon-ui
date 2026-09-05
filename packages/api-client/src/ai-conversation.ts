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
 * Wire types for AI agent conversations — the `AI_AGENT` layer OAP fills from
 * the AI Sessionizer's Session Data and Session Flow files (OAP 11.1.0+).
 *
 * Two reads. The LIST is a GraphQL query, `listConversations`, one row per
 * conversation from its newest round's header. The CONVERSATION itself is not
 * GraphQL: OAP serves it as one `asz.view` document from its own route on the
 * query host, streamed and compressed, because a long conversation is tens of
 * megabytes. The BFF relays that route byte for byte; the document's shape is
 * defined by the Sessionizer (`pkg/sessionview`), not here.
 */

/** One row of the list, straight from OAP's `ConversationRow`. Every value comes
 *  from the newest round's attributes; nothing is folded to build it. */
export interface AiConversationRow {
  conversation: string;
  /** The sender: one Sessionizer process on one machine. */
  serviceInstanceId: string;
  serviceInstanceName: string;
  /** Empty when the session carried no title — render a placeholder, never the id. */
  title: string;
  /** The head round this row came from. */
  round: number;
  talks: number;
  steps: number;
  streams: number;
  segments: number;
  unresolved: number;
  /** When the conversation began, epoch ms. */
  from: number;
  /** Its last activity so far, epoch ms. */
  to: number;
}

export interface AiConversationsQueryRequest {
  /** Service NAME. OAP's condition keys on the name (`ServiceCondition.serviceName`),
   *  so the id form other feeds carry has nowhere to go here. */
  service: string;
  /** Optional sender filter — a row's `serviceInstanceName`. */
  instanceName?: string;
  /** The newest N ROUNDS OAP reads in the window before folding them to one row
   *  per conversation. Not a row count: a chatty conversation spends the budget
   *  of quiet ones, so the BFF defaults this to the OAP ceiling. */
  limit?: number;
  /** Rolling window in minutes, ending at "now". Ignored when an explicit
   *  `startMs` / `endMs` pair is supplied. */
  windowMinutes?: number;
  /** Absolute range as epoch milliseconds. The BFF renders these in OAP-server
   *  time — send ms, never pre-formatted strings. */
  startMs?: number;
  endMs?: number;
}

export interface AiConversationsResponse {
  generatedAt: number;
  query: AiConversationsQueryRequest;
  /** The `limit` actually sent. OAP gives no signal whether it truncated
   *  anything, so the page states the rule with this number instead of
   *  pretending to know. */
  limit: number;
  /** Newest last activity first. */
  rows: AiConversationRow[];
  reachable: boolean;
  error?: string;
}

/** The first two keys of every `asz.view` document, and the media types the OAP
 *  route names it by. A reader that meets another major version stops there —
 *  a 1.x adds keys and never removes one; a 2.0 may do either. */
export const ASZ_VIEW_FORMAT = 'asz.view';
export const ASZ_VIEW_MAJOR_VERSION = 1;
export const ASZ_VIEW_JSON_MEDIA_TYPE = 'application/vnd.skywalking.asz.view+json';
export const ASZ_VIEW_YAML_MEDIA_TYPE = 'application/vnd.skywalking.asz.view+yaml';

/** What the view route answers with instead of a document: an RFC 9457 problem,
 *  `application/problem+json`. 400 without a service, 404 when the service
 *  stores no round of the conversation, 500 on a storage failure. */
export interface AiConversationProblem {
  type: string;
  title: string;
  status: number;
  detail: string;
}
