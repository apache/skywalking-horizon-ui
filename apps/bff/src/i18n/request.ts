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
 * Per-request locale resolution. The UI sends `X-Horizon-Locale` once
 * the user is bootstrapped; pre-bootstrap requests (the login flow,
 * `/api/health`) fall back to `Accept-Language` so even the very first
 * paint of the login page lands in the operator's language.
 *
 * Resolution order:
 *   1. `X-Horizon-Locale: <locale>` — exact-match, deliberate UI choice.
 *   2. `Accept-Language: …` — q-value parsed, first supported wins.
 *   3. `en` — fallback.
 *
 * Unsupported locales are silently dropped (rather than 400'd) so a
 * mismatched UI version never blocks a request — at worst the response
 * is English instead of the user's preference.
 */

import type { FastifyRequest } from 'fastify';
import type { Locale } from './types.js';
import { SUPPORTED_LOCALES, isLocale } from './types.js';

const HEADER = 'x-horizon-locale';

declare module 'fastify' {
  interface FastifyRequest {
    locale?: Locale;
  }
}

export function localeFromRequest(req: FastifyRequest): Locale {
  if (req.locale) return req.locale;
  const direct = parseHeader(req.headers[HEADER]);
  if (direct) {
    req.locale = direct;
    return direct;
  }
  const accept = parseAcceptLanguage(req.headers['accept-language']);
  req.locale = accept;
  return accept;
}

function parseHeader(raw: string | string[] | undefined): Locale | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string') return null;
  // Case-insensitive match against the canonical list — the wire form
  // is preserved (zh-CN, not zh-cn) so filenames keep their canonical
  // shape.
  const trimmed = v.trim();
  if (isLocale(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  const ci = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === lower);
  return ci ?? null;
}

function parseAcceptLanguage(raw: string | string[] | undefined): Locale {
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string' || header.length === 0) return 'en';
  // Tag, q-value pairs. `en-US,en;q=0.9,zh-CN;q=0.8` → ranked picks.
  const ranked = header
    .split(',')
    .map((part) => {
      const [tagRaw, ...params] = part.split(';').map((s) => s.trim());
      let q = 1;
      for (const p of params) {
        const m = p.match(/^q=([0-9.]+)$/i);
        if (m) {
          const parsed = Number.parseFloat(m[1]);
          if (Number.isFinite(parsed)) q = parsed;
        }
      }
      return { tag: tagRaw, q };
    })
    .filter((r) => r.q > 0 && r.tag.length > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const lower = tag.toLowerCase();
    // Exact match (case-insensitive).
    const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === lower);
    if (exact) return exact;
    // Prefix match — Accept-Language often arrives as a bare language
    // tag (`zh`, `pt`). Match the first supported variant that starts
    // with the same base.
    const base = lower.split('-')[0];
    const baseMatch = SUPPORTED_LOCALES.find(
      (l) => l !== 'en' && l.toLowerCase().split('-')[0] === base,
    );
    if (baseMatch) return baseMatch;
  }
  return 'en';
}
