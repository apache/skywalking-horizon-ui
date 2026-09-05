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
 * The two AI agent conversation reads OAP offers: `listConversations` over
 * GraphQL, and the `asz.view` document over OAP's own HTTP route on the query
 * host, `GET /ai-agent/conversations/{conversation}/v1/view`.
 *
 * The document is NOT fetched with `fetch`. Node's fetch decompresses a gzip
 * body on the way in and hands back decoded bytes under the original
 * `Content-Encoding` header, so a relay built on it would either forward a
 * header that lies about the bytes or re-compress a body Horizon registers no
 * compression plugin for. `node:http` hands the bytes over untouched, and the
 * browser receives exactly what OAP produced — measured on a real corpus, a
 * 61 MB document as 13 MB of gzip. The cost is that this one call runs outside
 * the wire log, which wraps `fetch`; the body would be truncated there anyway.
 */

import http from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import {
  ASZ_VIEW_JSON_MEDIA_TYPE,
  ASZ_VIEW_YAML_MEDIA_TYPE,
  type AiConversationRow,
} from '@skywalking-horizon-ui/api-client';
import { basicAuthHeader, graphqlPost, type GraphqlOptions } from './graphql.js';

export interface AiConversationDuration {
  start: string;
  end: string;
  step: 'SECOND';
  coldStage?: true;
}

export interface ListAiConversationsQuery {
  serviceName: string;
  instanceName?: string;
  /** The newest N rounds OAP reads before folding to one row per conversation. */
  limit: number;
  duration: AiConversationDuration;
}

const LIST_QUERY = /* GraphQL */ `
  query HorizonAiConversations($condition: ConversationListCondition!, $duration: Duration!) {
    listConversations(condition: $condition, duration: $duration) {
      errorReason
      conversations {
        conversation
        serviceInstanceId
        serviceInstanceName
        title
        round
        talks
        steps
        streams
        segments
        unresolved
        from
        to
      }
    }
  }
`;

interface ListRaw {
  listConversations?: {
    errorReason?: string | null;
    conversations?: Array<Record<string, unknown>> | null;
  } | null;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function toRow(r: Record<string, unknown>): AiConversationRow {
  return {
    conversation: str(r.conversation),
    serviceInstanceId: str(r.serviceInstanceId),
    serviceInstanceName: str(r.serviceInstanceName),
    title: str(r.title),
    round: num(r.round),
    talks: num(r.talks),
    steps: num(r.steps),
    streams: num(r.streams),
    segments: num(r.segments),
    unresolved: num(r.unresolved),
    from: num(r.from),
    to: num(r.to),
  };
}

/** One row per conversation of a service active in the window. The `instance`
 *  condition repeats the service name because OAP's `InstanceCondition` is
 *  addressed that way. */
export async function listAiConversations(
  opts: GraphqlOptions,
  q: ListAiConversationsQuery,
): Promise<{ rows: AiConversationRow[]; errorReason?: string }> {
  const condition: Record<string, unknown> = {
    service: { serviceName: q.serviceName },
    ...(q.instanceName
      ? { instance: { serviceName: q.serviceName, instanceName: q.instanceName } }
      : {}),
    limit: q.limit,
  };
  const raw = await graphqlPost<ListRaw>(opts, LIST_QUERY, { condition, duration: q.duration });
  const env = raw.listConversations;
  const rows = (env?.conversations ?? []).map(toRow);
  return env?.errorReason ? { rows, errorReason: env.errorReason } : { rows };
}

export interface AiConversationViewRequest {
  conversation: string;
  serviceName: string;
  instanceName?: string;
  /** `yaml` asks for the `+yaml` twin; anything else is the JSON document. */
  format: 'json' | 'yaml';
  /** The browser's own `Accept-Encoding`, forwarded verbatim so OAP compresses
   *  for the browser and the BFF never has to. Omitted → identity. */
  acceptEncoding?: string;
}

export interface AiConversationViewOptions {
  queryUrl: string;
  auth?: { username: string; password: string };
  /** Socket idle limit, and therefore the longest wait for the first byte —
   *  which is the whole fold on OAP's side. Not `oap.timeoutMs`. */
  timeoutMs: number;
  /** The caller's cancellation. Destroys the upstream socket, so an abandoned
   *  page stops the render on OAP too. */
  signal?: AbortSignal;
}

/** The OAP response, as it came: status, lower-cased headers, and the body as
 *  a stream of the bytes on the wire. `abort` drops the socket. */
export interface AiConversationViewUpstream {
  status: number;
  headers: Record<string, string>;
  body: Readable;
  abort(): void;
}

export class AiConversationViewTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the OAP conversation view sent nothing for ${timeoutMs} ms`);
    this.name = 'AiConversationViewTimeout';
  }
}

/** The route's path and query for one conversation, as OAP defines them. */
export function aiConversationViewPath(
  conversation: string,
  serviceName: string,
  instanceName?: string,
): string {
  const qs = new URLSearchParams({ service: serviceName });
  if (instanceName) qs.set('instance', instanceName);
  return `/ai-agent/conversations/${encodeURIComponent(conversation)}/v1/view?${qs.toString()}`;
}

export function openAiConversationView(
  opts: AiConversationViewOptions,
  q: AiConversationViewRequest,
): Promise<AiConversationViewUpstream> {
  const url = new URL(
    opts.queryUrl.replace(/\/$/, '') + aiConversationViewPath(q.conversation, q.serviceName, q.instanceName),
  );
  const lib = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = {
    accept: q.format === 'yaml' ? ASZ_VIEW_YAML_MEDIA_TYPE : ASZ_VIEW_JSON_MEDIA_TYPE,
  };
  if (q.acceptEncoding) headers['accept-encoding'] = q.acceptEncoding;
  if (opts.auth) headers.authorization = basicAuthHeader(opts.auth.username, opts.auth.password);

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }
    const req = lib.request(url, { method: 'GET', headers, timeout: opts.timeoutMs }, (res) => {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === 'string') flat[k.toLowerCase()] = v;
        else if (Array.isArray(v)) flat[k.toLowerCase()] = v.join(', ');
      }
      resolve({
        status: res.statusCode ?? 502,
        headers: flat,
        body: res,
        abort: () => req.destroy(abortError()),
      });
    });
    // `timeout` on the request is socket idleness, so it covers both the wait
    // for the first byte and a stall mid-stream. Node only emits the event; the
    // destroy is ours, and it rejects before a response or errors the body
    // stream after one.
    req.on('timeout', () => req.destroy(new AiConversationViewTimeout(opts.timeoutMs)));
    req.on('error', (err) => reject(err));
    opts.signal?.addEventListener('abort', () => req.destroy(abortError()), { once: true });
    req.end();
  });
}

function abortError(): Error {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}
