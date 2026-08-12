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

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { dirname, resolve } from 'node:path';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { logger } from '../logger.js';

/**
 * Wire-level debug log for outbound OAP traffic (`debugLog` in
 * horizon.yaml). One JSONL line per request/response pair, written to
 * `debugLog.file`. Off by default; every knob hot-reloads because the
 * settings are re-read from the live config on each call.
 *
 * Coverage comes from wrapping fetch at the OAP boundary with
 * {@link wireFetch} — the GraphQL client, the Zipkin client, the
 * config-dump probes, and every api-client admin-REST client (via
 * `buildOapClients`). LLM-provider traffic is deliberately NOT wired
 * through this: the wire log is an OAP troubleshooting tool and must
 * never see the AI api key.
 */
export interface WireLogSettings {
  enabled: boolean;
  file: string;
  maxBodyChars: number;
  redactAuthHeaders: boolean;
}

interface WireEntry {
  ts: string;
  method: string;
  url: string;
  status?: number;
  elapsedMs: number;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  error?: string;
}

const REDACTED_HEADERS = new Set(['authorization', 'proxy-authorization']);

class WireLog {
  private getSettings: (() => WireLogSettings) | null = null;
  private stream: WriteStream | null = null;
  private streamPath: string | null = null;
  /** Flushes of streams rotated away by a `debugLog.file` change, still
   *  draining. `close()` awaits these too so nothing written just before a
   *  hot reload is lost. */
  private readonly rotating = new Set<Promise<void>>();

  /** Wire the live config getter in (server boot). Uninitialized (tests,
   *  CLI tools) the log is a hard no-op. */
  init(getSettings: () => WireLogSettings): void {
    this.getSettings = getSettings;
    const s = getSettings();
    if (s.enabled) {
      logger.warn(
        { file: s.file },
        'debugLog.enabled — every outbound OAP request/response is being appended to the wire log (very verbose; disable after troubleshooting)',
      );
    }
  }

  settings(): WireLogSettings | null {
    return this.getSettings?.() ?? null;
  }

  enabled(): boolean {
    return this.settings()?.enabled ?? false;
  }

  record(entry: WireEntry): void {
    const s = this.settings();
    if (!s?.enabled) return;
    const absPath = resolve(s.file);
    if (!this.stream || this.streamPath !== absPath) {
      // A `debugLog.file` hot reload rotates the stream. end() only QUEUES the
      // flush, so the outgoing stream is tracked until it finishes — otherwise
      // close() (which awaits the live stream only) can return while the last
      // entries written before the rotation are still in the buffer, and a
      // shutdown right after a config edit drops them.
      const outgoing = this.stream;
      if (outgoing) {
        const pending = finished(outgoing).catch(() => undefined);
        this.rotating.add(pending);
        void pending.finally(() => this.rotating.delete(pending));
        outgoing.end();
      }
      try {
        mkdirSync(dirname(absPath), { recursive: true });
        const stream = createWriteStream(absPath, { flags: 'a' });
        // Async open/write failures (EACCES, ENOSPC, …) surface via 'error',
        // not by throwing — drop the dead stream so the next record() retries
        // a fresh open instead of spamming ERR_STREAM_DESTROYED forever.
        stream.on('error', (err) => {
          logger.error({ err, file: absPath }, 'wire log stream error — will reopen on next entry');
          if (this.stream === stream) {
            this.stream = null;
            this.streamPath = null;
          }
          stream.destroy();
        });
        this.stream = stream;
        this.streamPath = absPath;
      } catch (err) {
        logger.error({ err, file: absPath }, 'wire log unwritable — entry dropped');
        this.stream = null;
        this.streamPath = null;
        return;
      }
    }
    this.stream.write(JSON.stringify(entry) + '\n');
  }

  /** Flush + release the file, including any stream a `debugLog.file`
   *  change rotated away that is still draining. Safe to call when nothing
   *  was opened; the next record() after this reopens lazily. */
  async close(): Promise<void> {
    const live = this.stream;
    this.stream = null;
    this.streamPath = null;
    const pending = [...this.rotating];
    if (live) pending.push(new Promise<void>((done) => live.end(() => done())));
    await Promise.all(pending);
  }
}

export const wireLog = new WireLog();

function headersToRecord(
  h: HeadersInit | Headers | undefined,
  redactAuth: boolean,
): Record<string, string> | undefined {
  if (!h) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of new Headers(h)) {
    out[k] = redactAuth && REDACTED_HEADERS.has(k) ? '<redacted>' : v;
  }
  return out;
}

function bodyText(body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null) return undefined;
  return typeof body === 'string' ? body : '<non-string body>';
}

function truncate(s: string | undefined, maxChars: number): string | undefined {
  if (s === undefined) return undefined;
  if (maxChars <= 0) return undefined;
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `…[truncated, ${s.length} chars total]`;
}

// Response bodies must be null for these statuses — the Response
// constructor throws otherwise when we rebuild the reply below.
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

// Only decode the response body into the log when it is textual — a
// binary payload (the runtime-rule dump is a tar.gz) is logged as a
// size marker. The BYTES are always passed through untouched.
const TEXTY_CONTENT_TYPE = /json|text|xml|yaml|javascript|urlencoded/i;

function responseBodyForLog(buf: Buffer, contentType: string, maxChars: number): string | undefined {
  if (maxChars <= 0 || buf.length === 0) return undefined;
  if (contentType && !TEXTY_CONTENT_TYPE.test(contentType)) return `<binary, ${buf.length} bytes>`;
  return truncate(buf.toString('utf8'), maxChars);
}

/**
 * Wrap a fetch with wire logging. When the log is disabled (the default)
 * the original fetch is called untouched. When enabled, the response
 * body is buffered ONCE here as raw bytes and the caller receives a
 * byte-identical rebuilt `Response` — rebuilt rather than `clone()`d
 * because a cloned body tees the stream, and probe-style callers that
 * only look at `.status` would leave the other branch unread. Buffering
 * is fine at debug-log volume, but note the caller's timeout then also
 * covers the body download (documented on the debug-log page).
 */
export function wireFetch(f: FetchLike): FetchLike {
  return async (input, init) => {
    const s = wireLog.settings();
    if (!s?.enabled) return f(input, init);
    const started = Date.now();
    const base = {
      ts: new Date(started).toISOString(),
      method: (init?.method ?? 'GET').toUpperCase(),
      url: String(input),
      requestHeaders: headersToRecord(init?.headers, s.redactAuthHeaders),
      requestBody: truncate(bodyText(init?.body), s.maxBodyChars),
    };
    let res: Response;
    let body: Buffer;
    try {
      res = await f(input, init);
      body = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      wireLog.record({
        ...base,
        elapsedMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    const contentType = res.headers.get('content-type') ?? '';
    wireLog.record({
      ...base,
      status: res.status,
      elapsedMs: Date.now() - started,
      responseHeaders: headersToRecord(res.headers, s.redactAuthHeaders),
      responseBody: responseBodyForLog(body, contentType, s.maxBodyChars),
    });
    return new Response(NULL_BODY_STATUS.has(res.status) || body.length === 0 ? null : body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
