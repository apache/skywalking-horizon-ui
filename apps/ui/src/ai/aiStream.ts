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

// Real BFF chat stream. POSTs the conversation to `/api/ai/chat` and yields the
// SSE events (same `SseEvent` shape the panel already renders — the M1 mock is a
// drop-in for this). No shared BffClient path exists for streaming, so this owns
// its fetch (credentials + locale header, like BffClient.request).

import { bffClient, withBase } from '@/api/client';
import { currentLocale, i18n } from '@/i18n';
import type { SseEvent } from './types';

const t = (key: string, named?: Record<string, unknown>): string =>
  named ? i18n.global.t(key, named) : i18n.global.t(key);

export interface AiStreamRange {
  startMs: number;
  endMs: number;
  step: 'MINUTE' | 'HOUR' | 'DAY';
}

export interface AiTurn {
  role: 'user' | 'assistant';
  content: string;
}

function readableError(status: number, body: unknown): string {
  const err = (body as { error?: string; detail?: string } | null)?.error;
  if (err === 'ai_disabled') return t('The AI assistant is disabled on this server.');
  if (err === 'ai_unconfigured') {
    const detail = (body as { detail?: string }).detail;
    const base = t('The AI assistant is not fully configured on this server.');
    return detail ? `${base} (${detail})` : base;
  }
  if (status === 403) return t('You do not have permission to use the AI assistant.');
  return t('AI request failed ({status}).', { status });
}

export async function* streamAnswer(
  messages: AiTurn[],
  range: AiStreamRange,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  let res: Response;
  try {
    res = await fetch(withBase('/api/ai/chat'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Horizon-Locale': currentLocale() },
      body: JSON.stringify({ messages, ...range }),
      signal,
    });
  } catch {
    if (signal?.aborted) {
      yield { type: 'done' };
      return;
    }
    yield { type: 'error', message: t('Cannot reach the server.') };
    yield { type: 'done' };
    return;
  }

  if (res.status === 401) {
    // Mid-session session expiry. This request owns its fetch (no shared
    // request() path for streaming), so fire the SAME re-auth hook every other
    // request routes through — clears auth state + bounces to /login — instead
    // of leaving the operator on a dead panel (mirrors configs.ts / dsl.ts).
    bffClient.handleUnauthorized();
    yield { type: 'error', message: t('Your session has expired. Please sign in again.') };
    yield { type: 'done' };
    return;
  }

  if (!res.ok || !res.body) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    yield { type: 'error', message: readableError(res.status, body) };
    yield { type: 'done' };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE frames are separated by a blank line.
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of frame.split('\n')) {
          const trimmed = line.replace(/^﻿/, '');
          if (!trimmed.startsWith('data:')) continue; // skip `: ping` comments
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          try {
            yield JSON.parse(data) as SseEvent;
          } catch {
            /* skip a malformed frame rather than abort the stream */
          }
        }
      }
    }
  } catch {
    // The connection dropped mid-answer (or the caller aborted). Surface an
    // error block unless the user stopped it themselves, then close cleanly —
    // otherwise the read rejection escapes as an unhandled rejection.
    if (!signal?.aborted) yield { type: 'error', message: t('Cannot reach the server.') };
    yield { type: 'done' };
  }
}
