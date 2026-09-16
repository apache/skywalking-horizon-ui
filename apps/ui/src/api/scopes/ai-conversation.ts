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
  AI_CONVERSATION_DOCUMENT_BYTES_HEADER,
  AI_CONVERSATION_DOCUMENT_SUMMARY_HEADER,
  ASZ_FILES_MEDIA_TYPE,
  ASZ_VIEW_FORMAT,
  ASZ_VIEW_JSON_MEDIA_TYPE,
  ASZ_VIEW_MAJOR_VERSION,
  type AiConversationDocumentSummary,
  type AiConversationsQueryRequest,
  type AiConversationsResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';
import { withBase } from '../client';
import { COLD_STAGE_HEADER, readColdStageHeader } from '@/controls/coldStage';
import { pushEvent } from '@/controls/eventLog';

/** Why a conversation document could not be read. `not_found` and
 *  `bad_request` are OAP's own answers (RFC 9457 problems); `timeout` and
 *  `unreachable` are the BFF's, when OAP took longer than its budget or was
 *  not there; `unsupported` is a document of another format or major version. */
export type AiConversationViewFailure =
  | 'bad_request'
  | 'not_found'
  /** A 404 with no problem document: OAP has no conversation route at all,
   *  which is an OAP older than 11.1.0. */
  | 'not_served'
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
  /** `receiving` from the first byte on; `parsing` once every byte is in and
   *  the document is being read. */
  phase: 'receiving' | 'parsing';
  /** Decoded bytes received so far. */
  bytes: number;
  /** The document's decoded size, as the BFF states it ahead of the bytes;
   *  null when it did not (an older BFF, or an encoding it could not count). */
  total: number | null;
  /** The document's counts, read by the BFF off its head; null when absent. */
  summary: AiConversationDocumentSummary | null;
}

export interface AiConversationViewResult {
  /** The parsed document. Its `format` and major `version` are checked here;
   *  the page narrows the type with the renderer's own guard. */
  document: unknown;
  bytes: number;
  total: number | null;
  summary: AiConversationDocumentSummary | null;
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

  /** The BFF path of a session's stored files, by their landed seqs. */
  filesPath(conversation: string, q: { service: string; instance: string; session: string; seqs: number[] }): string {
    const params = new URLSearchParams({ service: q.service, instance: q.instance, session: q.session });
    for (const seq of q.seqs) params.append('seq', String(seq));
    return `/api/ai-conversation/${encodeURIComponent(conversation)}/files?${params}`;
  }

  /**
   * The stored files of a session, handed over one at a time as they arrive.
   *
   * The body is `application/vnd.skywalking.asz.files+ndjson`: for each file a naming line, then
   * exactly the bytes it names, then one newline after a non-empty file that does not end with one.
   * It is read as bytes, never as text, because a file's bytes are what its digest covers.
   */
  async files(
    conversation: string,
    q: { service: string; instance: string; session: string; seqs: number[] },
    onFile: (file: { seq: number; file: string; bytes: Uint8Array }) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const path = this.filesPath(conversation, q);
    let res: Response;
    try {
      res = await fetch(withBase(path), {
        credentials: 'include',
        headers: {
          accept: ASZ_FILES_MEDIA_TYPE,
          ...(readColdStageHeader() ? { [COLD_STAGE_HEADER]: '1' } : {}),
        },
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
      throw new AiConversationViewError('unauthenticated', 401, 'The session has ended.');
    }
    if (!res.ok || !res.body) {
      throw await failureOf(res, path);
    }
    await readFiles(res.body, onFile);
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
        headers: {
          accept: ASZ_VIEW_JSON_MEDIA_TYPE,
          ...(readColdStageHeader() ? { [COLD_STAGE_HEADER]: '1' } : {}),
        },
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
    const total = sizeHeader(res.headers.get(AI_CONVERSATION_DOCUMENT_BYTES_HEADER));
    const summary = summaryHeader(res.headers.get(AI_CONVERSATION_DOCUMENT_SUMMARY_HEADER));
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    // The headers are the first byte: the page can leave its waiting state now.
    opts.onProgress?.({ phase: 'receiving', bytes, total, summary });
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        bytes += value.byteLength;
        opts.onProgress?.({ phase: 'receiving', bytes, total, summary });
      }
    } else {
      const one = new Uint8Array(await res.arrayBuffer());
      chunks.push(one);
      bytes = one.byteLength;
      opts.onProgress?.({ phase: 'receiving', bytes, total, summary });
    }
    opts.onProgress?.({ phase: 'parsing', bytes, total, summary });
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
    return { document, bytes, total, summary, elapsedMs: Math.round(performance.now() - started) };
  }
}

function sizeHeader(v: string | null): number | null {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function summaryHeader(v: string | null): AiConversationDocumentSummary | null {
  if (!v) return null;
  try {
    const s = JSON.parse(v) as Record<string, unknown>;
    const keys = ['talks', 'steps', 'streams', 'segments', 'rounds', 'unresolved'] as const;
    if (keys.every((k) => typeof s[k] === 'number')) return s as unknown as AiConversationDocumentSummary;
  } catch {
    /* a header this BFF did not write */
  }
  return null;
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
  const problem = str('title') !== null || str('detail') !== null;
  const kind: AiConversationViewFailure =
    res.status === 400
      ? 'bad_request'
      : res.status === 403
        ? 'forbidden'
        : res.status === 404
          ? problem
            ? 'not_found'
            : 'not_served'
          : res.status === 504 || str('error') === 'oap_timeout'
            ? 'timeout'
            : res.status === 502 || str('error') === 'oap_unreachable'
              ? 'unreachable'
              : 'http';
  pushEvent('api', 'err', `GET ${path} · ${res.status} ${title}`);
  return new AiConversationViewError(kind, res.status, title, detail);
}

/**
 * Reads a files body: for each stored file a naming line, then exactly `bytes` bytes, then the one
 * newline that follows a non-empty file not ending with its own. The reader holds only what it has
 * not handed over yet, so a stream of many files never sits in memory whole.
 */
export async function readFiles(
  body: ReadableStream<Uint8Array>,
  onFile: (file: { seq: number; file: string; bytes: Uint8Array }) => void,
): Promise<void> {
  const reader = body.getReader();
  try {
    await frame(reader, onFile);
  } catch (err) {
    // A body this reader refuses is a body nobody will read: the request is ended rather than left
    // running, so the browser stops receiving it and the relay behind it stops asking OAP for more.
    // Cancelling stops the stream; the lock is the reader's own and is given back after it.
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
    throw err;
  }
}

async function frame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onFile: (file: { seq: number; file: string; bytes: Uint8Array }) => void,
): Promise<void> {
  const held = new Held();
  let naming: { file: string; seq: number; bytes: number } | null = null;
  const bad = (why: string): AiConversationViewError => new AiConversationViewError('unsupported', 200, why);
  for (;;) {
    const { value, done } = await reader.read();
    if (value?.length) held.push(value);
    for (;;) {
      if (!naming) {
        const end = held.indexOf(0x0a);
        if (end < 0) break;
        const line = new TextDecoder().decode(held.take(end));
        held.skip(1);
        let parsed: { file?: unknown; seq?: unknown; bytes?: unknown };
        try {
          parsed = JSON.parse(line) as { file?: unknown; seq?: unknown; bytes?: unknown };
        } catch {
          throw bad('The files response is not the framing this reader knows.');
        }
        if (typeof parsed.file !== 'string' || !Number.isSafeInteger(parsed.seq) || !Number.isSafeInteger(parsed.bytes) || (parsed.bytes as number) < 0) {
          throw bad('The files response is not the framing this reader knows.');
        }
        naming = { file: parsed.file, seq: parsed.seq as number, bytes: parsed.bytes as number };
      }
      if (held.length < naming.bytes) break;
      // A file that does not end with a newline of its own is followed by one, which is not part of
      // it. Where that byte is expected it is checked: a different byte there means the count was not
      // the file's, and everything after it would be read at the wrong offset.
      const delimited = naming.bytes > 0 && held.at(naming.bytes - 1) !== 0x0a;
      if (delimited && held.length < naming.bytes + 1) break;
      const bytes = held.take(naming.bytes);
      if (delimited) {
        if (held.at(0) !== 0x0a) throw bad('The files response is not the framing this reader knows.');
        held.skip(1);
      }
      onFile({ seq: naming.seq, file: naming.file, bytes });
      naming = null;
    }
    if (done) {
      if (naming || held.length) throw bad('The files response ended inside a file.');
      return;
    }
  }
}

/**
 * The bytes read and not handed over yet, as the chunks they arrived in.
 *
 * Joining every chunk onto one buffer copies what is already held again for each one, which on a file
 * of a few megabytes arriving in small chunks is hundreds of megabytes of copying. The chunks are kept
 * as they came and only what a frame needs is copied out, once.
 */
class Held {
  private chunks: Uint8Array[] = [];
  /** The chunk being read, and how far into it has been handed over. Shifting the array instead
   *  would move every chunk still held on each one consumed, which on a file arriving in thousands
   *  of small chunks is the same quadratic cost the copying had. */
  private head = 0;
  private from = 0;
  length = 0;

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** The byte at that offset of what is not handed over yet, or -1 past the end. */
  at(offset: number): number {
    let left = offset + this.from;
    for (let i = this.head; i < this.chunks.length; i++) {
      const c = this.chunks[i]!;
      if (left < c.length) return c[left]!;
      left -= c.length;
    }
    return -1;
  }

  /** Where the byte first occurs, counted from what is not handed over yet, or -1. */
  indexOf(byte: number): number {
    let before = 0;
    let from = this.from;
    for (let i = this.head; i < this.chunks.length; i++) {
      const c = this.chunks[i]!;
      const found = c.indexOf(byte, from);
      if (found >= 0) return before + found - from;
      before += c.length - from;
      from = 0;
    }
    return -1;
  }

  /** The first `n` bytes, copied out once and dropped from what is held. */
  take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const c = this.chunks[this.head]!;
      const step = Math.min(n - written, c.length - this.from);
      out.set(c.subarray(this.from, this.from + step), written);
      written += step;
      this.advance(step);
    }
    return out;
  }

  skip(n: number): void {
    let left = n;
    while (left > 0) left -= this.advance(Math.min(left, this.chunks[this.head]!.length - this.from));
  }

  private advance(step: number): number {
    this.from += step;
    this.length -= step;
    if (this.from >= this.chunks[this.head]!.length) {
      this.chunks[this.head] = EMPTY; // let the bytes go before the array is tidied
      this.head++;
      this.from = 0;
      // Tidy once the read chunks outnumber the held ones, so the array never grows without bound
      // and no chunk is moved more than once.
      if (this.head > 32 && this.head * 2 > this.chunks.length) {
        this.chunks = this.chunks.slice(this.head);
        this.head = 0;
      }
    }
    return step;
  }
}

const EMPTY = new Uint8Array(0);

