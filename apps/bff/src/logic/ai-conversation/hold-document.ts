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

import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { AiConversationDocumentSummary } from '@skywalking-horizon-ui/api-client';

/**
 * Holds a conversation document as OAP streams it, so the browser can be told
 * its size before the first byte. OAP writes the document as it walks it and
 * never knows the length; the BFF is the first party that does. What is held
 * is the wire body (gzip, a fifth of the document), decoded once only to count
 * and to read the summary off the head.
 */
export interface HeldDocument {
  /** The body as OAP sent it, still encoded. */
  body: Buffer;
  /** Decoded length, or null when the encoding is one this cannot decode. */
  decodedBytes: number | null;
  summary: AiConversationDocumentSummary | null;
}

/** How much of the decoded head is kept for the summary scan. The summary sits
 *  after a handful of short fields; a title is the only free text before it. */
const HEAD_BYTES = 256 * 1024;

export async function holdDocument(
  body: Readable,
  contentEncoding: string | undefined,
  opts: { summary: boolean },
): Promise<HeldDocument> {
  const encoding = (contentEncoding ?? '').trim().toLowerCase();
  const decoder = encoding === 'gzip' ? createGunzip() : null;
  const decodable = decoder !== null || encoding === '' || encoding === 'identity';
  const chunks: Buffer[] = [];
  const head: Buffer[] = [];
  let raw = 0;
  let decoded = 0;
  let headLen = 0;
  const onDecoded = (d: Buffer): void => {
    decoded += d.length;
    if (headLen < HEAD_BYTES) {
      head.push(d);
      headLen += d.length;
    }
  };
  // The decoder's failure is caught the moment it can happen: a bad gzip
  // rejects `finished` while the loop is still awaiting the body, and an
  // unhandled rejection there takes the process down.
  const failed: { error: Error | null } = { error: null };
  let decoderDone: Promise<void> | null = null;
  if (decoder) {
    decoder.on('data', onDecoded);
    decoderDone = finished(decoder).catch((err: unknown) => {
      failed.error = err instanceof Error ? err : new Error(String(err));
    });
  }
  for await (const chunk of body) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    chunks.push(b);
    raw += b.length;
    if (decoder) {
      if (failed.error || decoder.destroyed) break;
      if (!decoder.write(b)) await once(decoder, 'drain').catch(() => undefined);
    } else if (decodable) {
      onDecoded(b);
    }
  }
  if (decoder) {
    if (!decoder.destroyed) decoder.end();
    await decoderDone;
    if (failed.error) throw new Error(`the document could not be decoded: ${failed.error.message}`);
  }
  const summary = opts.summary && decodable ? summaryFromHead(Buffer.concat(head, headLen).toString('utf8')) : null;
  return { body: Buffer.concat(chunks, raw), decodedBytes: decodable ? decoded : null, summary };
}

const COUNTS = ['talks', 'steps', 'streams', 'segments', 'rounds', 'unresolved'] as const;

/** The document's top-level `summary` object, read off its head without
 *  parsing the whole. Null when the head does not hold the complete object. */
export function summaryFromHead(text: string): AiConversationDocumentSummary | null {
  const start = topLevelKey(text, 'summary');
  if (start < 0) return null;
  const obj = objectAt(text, start);
  if (!obj) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(obj);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const s = parsed as Record<string, unknown>;
  const out: Partial<AiConversationDocumentSummary> = {};
  for (const k of COUNTS) {
    const v = s[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[k] = v;
  }
  return out as AiConversationDocumentSummary;
}

/** Index of the `{` that opens the value of `key` at depth 1, or -1. Strings
 *  are skipped, so a title that happens to contain the key cannot match. */
function topLevelKey(text: string, key: string): number {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      if (end < 0) return -1;
      if (depth === 1 && text.slice(i + 1, end) === key) {
        let j = end + 1;
        while (j < text.length && /\s/.test(text[j]!)) j++;
        if (text[j] === ':') {
          j++;
          while (j < text.length && /\s/.test(text[j]!)) j++;
          if (text[j] === '{') return j;
        }
      }
      i = end + 1;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    i++;
  }
  return -1;
}

/** The balanced object starting at `start`, or null when it is cut off. */
function objectAt(text: string, start: number): string | null {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
    i++;
  }
  return null;
}

/** Index of the closing quote of the JSON string opening at `at`, or -1. */
function stringEnd(text: string, at: number): number {
  let i = at + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i;
    i++;
  }
  return -1;
}
