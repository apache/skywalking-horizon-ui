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

import {
  ASZ_VIEW_FORMAT,
  ASZ_VIEW_JSON_MEDIA_TYPE,
  ASZ_VIEW_MAJOR_VERSION,
  type AiConversationsQueryRequest,
  type AiConversationsResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';
import { withBase } from '../client';
import { pushEvent } from '@/controls/eventLog';

/** Why a conversation document could not be read. `not_found` and
 *  `bad_request` are OAP's own answers (RFC 9457 problems); `timeout` and
 *  `unreachable` are the BFF's, when OAP took longer than its budget or was
 *  not there; `unsupported` is a document of another format or major version. */
export type AiConversationViewFailure =
  | 'bad_request'
  | 'not_found'
  | 'forbidden'
  | 'unauthenticated'
  | 'timeout'
  | 'unreachable'
  | 'unsupported'
  | 'network'
  | 'http';

export class AiConversationViewError extends Error {
  constructor(
    readonly kind: AiConversationViewFailure,
    readonly status: number,
    message: string,
    /** The problem's `detail`, or the BFF's `message`, when either was sent. */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'AiConversationViewError';
  }
}

export interface AiConversationViewProgress {
  /** Decoded bytes received so far. The wire is gzip and its length is not
   *  the document's, so there is no total to show against. */
  bytes: number;
}

export interface AiConversationViewResult {
  /** The parsed document. Its `format` and major `version` are checked here;
   *  the page narrows the type with the renderer's own guard. */
  document: unknown;
  bytes: number;
  elapsedMs: number;
}

/** `bff.aiConversation` — the AI agent conversations of an `AI_AGENT` layer
 *  service: the list, one row per conversation, and the conversation document
 *  itself. The document is a streamed relay of up to tens of megabytes whose
 *  first byte arrives only once OAP has folded the whole chain, so it bypasses
 *  the JSON façade to report progress while the body streams in. */
export class AiConversationApi {
  constructor(private readonly bff: BffClient) {}

  list(
    layerKey: string,
    body: AiConversationsQueryRequest,
    signal?: AbortSignal,
  ): Promise<AiConversationsResponse> {
    return this.bff.request<AiConversationsResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/ai-conversations`,
      body,
      undefined,
      signal,
    );
  }

  /** The BFF path of one conversation document, as a link a browser can open. */
  viewPath(conversation: string, q: { service: string; instance?: string }): string {
    const params = new URLSearchParams({ service: q.service });
    if (q.instance) params.set('instance', q.instance);
    return `/api/ai-conversation/${encodeURIComponent(conversation)}/view?${params}`;
  }

  async view(
    conversation: string,
    q: { service: string; instance?: string },
    opts: { signal?: AbortSignal; onProgress?: (p: AiConversationViewProgress) => void } = {},
  ): Promise<AiConversationViewResult> {
    const path = this.viewPath(conversation, q);
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(withBase(path), {
        credentials: 'include',
        headers: { accept: ASZ_VIEW_JSON_MEDIA_TYPE },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      const detail = err instanceof Error ? err.message : String(err);
      pushEvent('api', 'err', `GET ${path} · network ${detail}`);
      throw new AiConversationViewError('network', 0, `Cannot reach the server — the BFF is unreachable (${detail}).`);
    }
    if (res.status === 401) {
      this.bff.handleUnauthorized();
      pushEvent('api', 'info', `GET ${path} · 401 (re-auth)`);
      throw new AiConversationViewError('unauthenticated', 401, 'unauthenticated');
    }
    if (!res.ok) {
      throw await failureOf(res, path);
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        bytes += value.byteLength;
        opts.onProgress?.({ bytes });
      }
    } else {
      const one = new Uint8Array(await res.arrayBuffer());
      chunks.push(one);
      bytes = one.byteLength;
      opts.onProgress?.({ bytes });
    }
    const whole = new Uint8Array(bytes);
    let at = 0;
    for (const c of chunks) {
      whole.set(c, at);
      at += c.byteLength;
    }
    let document: unknown;
    try {
      document = JSON.parse(new TextDecoder().decode(whole));
    } catch (err) {
      pushEvent('api', 'err', `GET ${path} · body is not JSON`);
      throw new AiConversationViewError('unsupported', res.status, 'The conversation document is not JSON.', err instanceof Error ? err.message : null);
    }
    const head = document as { format?: unknown; version?: unknown } | null;
    const major = typeof head?.version === 'string' ? Number(head.version.split('.')[0]) : NaN;
    if (!head || head.format !== ASZ_VIEW_FORMAT || major !== ASZ_VIEW_MAJOR_VERSION) {
      throw new AiConversationViewError(
        'unsupported',
        res.status,
        `Unsupported conversation document: ${String(head?.format)} ${String(head?.version)}.`,
      );
    }
    return { document, bytes, elapsedMs: Math.round(performance.now() - started) };
  }
}

/** OAP answers with an RFC 9457 problem (`title`, `detail`, `status`); the
 *  BFF's own refusals carry `{ error, message }`. Either way the operator gets
 *  the sentence the server wrote, not just the number. */
async function failureOf(res: Response, path: string): Promise<AiConversationViewError> {
  const raw = await res.text().catch(() => '');
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  const str = (k: string): string | null => (typeof body?.[k] === 'string' ? (body[k] as string) : null);
  const detail = str('detail') ?? str('message');
  const title = str('title') ?? str('error') ?? `HTTP ${res.status}`;
  const kind: AiConversationViewFailure =
    res.status === 400
      ? 'bad_request'
      : res.status === 403
        ? 'forbidden'
        : res.status === 404
          ? 'not_found'
          : res.status === 504 || str('error') === 'oap_timeout'
            ? 'timeout'
            : res.status === 502 || str('error') === 'oap_unreachable'
              ? 'unreachable'
              : 'http';
  pushEvent('api', 'err', `GET ${path} · ${res.status} ${title}`);
  return new AiConversationViewError(kind, res.status, title, detail);
}
