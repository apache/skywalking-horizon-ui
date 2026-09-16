/*
 * Licensed to Apache Software Foundation (ASF) under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Apache Software Foundation (ASF) licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * The provider bodies of one session, as the Sessionizer's `pkg/providerbody` holds them.
 *
 * A body is stored cut: a record keeps only what the session did not hold yet, and its last part is a
 * `provider_body/1` manifest whose segments say how to put the body back together. A segment is a
 * literal, one of the record's own parts, a piece an earlier record holds, or the front of an earlier
 * body. So the bodies of a session must be added in the order they landed, which is why a reader loads
 * every provider file up to the one it wants.
 *
 * Bytes are kept as bytes. A part's `data` is the source's own JSON, byte for byte, so it is taken from
 * the record line verbatim rather than decoded and printed again, which would change escapes, spacing
 * and number spelling and break both the piece lookup and the digest.
 */

import { sha256Hex } from './sha256.js';

/** The largest body this reader rebuilds, as the Sessionizer's MaxBytes. */
export const MAX_BODY_BYTES = 256 * 1024 * 1024;
/** The deepest chain of copies, as the Sessionizer's MaxDepth. */
export const MAX_DEPTH = 32;
/** Rebuilt bodies kept, in bytes, before the oldest is dropped. */
const CACHE_LIMIT = 32 * 1024 * 1024;

export const ROLE_REQUEST = 'request';
export const ROLE_RESPONSE = 'response';

export interface PromptCopy {
  from: string;
  sha256: string;
  len: number;
}

export interface PromptSegment {
  lit?: string;
  part?: number;
  piece?: string;
  copy?: PromptCopy;
}

/** The manifest of one body, in the model's words. */
export interface PromptManifest {
  schema: string;
  role: string;
  src?: string;
  sha256: string;
  bytes: number;
  depth: number;
  chain?: string;
  why?: string;
  model?: string;
  session?: string;
  run?: string;
  call?: string;
  request?: string;
  previous_request?: string;
  segments: PromptSegment[];
}

interface Part {
  kind: string;
  /** The part's `data` as the record line spells it, or null when it has none. */
  raw: string | null;
  encoding?: string;
}

export interface PromptRecord {
  id: string;
  seq: number;
  row: number;
  parts: Part[];
  manifest: PromptManifest;
}

export const PROMPT_SCHEMA = 'provider_body/1';

const encoder = new TextEncoder();
// Fatal, so an invalid byte ends the file instead of becoming a replacement character. A part's
// bytes are what its digest covers, and a decoder that mends them would verify bytes the record
// never held.
const decoder = new TextDecoder('utf-8', { fatal: true });

/** One file as a host hands it over: the landed seq, the name, and its bytes. */
export interface StoredFile {
  seq: number;
  file: string;
  bytes: Uint8Array;
}

/**
 * The records of one `provider_body` file, in line order. The header is row 0 and the closing line is
 * no record, as a Session Data reader counts them. A line that does not read ends the file there,
 * and a record that is not a provider body is skipped.
 */
export function readProviderFile(seq: number, bytes: Uint8Array): PromptRecord[] {
  const out: PromptRecord[] = [];
  let row = 0;
  for (const line of splitLines(bytes)) {
    if (row === 0) {
      row++;
      continue; // the header
    }
    let text: string;
    let node: Record<string, unknown>;
    try {
      text = decoder.decode(line);
      node = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return out; // a line that does not read ends the records, as the Sessionizer's reader does
    }
    if (node['t'] === 'end') return out;
    const record = readRecord(seq, row, node, text);
    if (record) out.push(record);
    row++;
  }
  return out;
}

function readRecord(seq: number, row: number, node: Record<string, unknown>, line: string): PromptRecord | null {
  const parts = Array.isArray(node['parts']) ? (node['parts'] as Array<Record<string, unknown>>) : [];
  if (!parts.length) return null;
  const raws = rawPartData(line);
  const read: Part[] = parts.map((p, i) => ({
    kind: typeof p['k'] === 'string' ? (p['k'] as string) : '',
    raw: raws[i] ?? null,
    encoding: typeof p['encoding'] === 'string' ? (p['encoding'] as string) : undefined,
  }));
  const last = read[read.length - 1]!;
  if (last.kind !== 'data' || last.raw === null) return null;
  let manifest: PromptManifest;
  try {
    manifest = JSON.parse(last.raw) as PromptManifest;
  } catch {
    return null;
  }
  if (!wellFormed(manifest)) return null;
  const id = typeof node['id'] === 'string' ? (node['id'] as string) : '';
  if (!id) return null;
  return { id, seq, row, parts: read, manifest };
}

/**
 * Whether the manifest is the shape this reader works on. The types are checked, not only the values:
 * a `bytes` that is an object compares as smaller than the budget and larger than zero, and would
 * then be handed to `new Uint8Array`. The Sessionizer's own decoder refuses the same records.
 */
function wellFormed(m: PromptManifest | null): boolean {
  if (!m || typeof m !== 'object') return false;
  if (m.schema !== PROMPT_SCHEMA || typeof m.sha256 !== 'string' || typeof m.role !== 'string') return false;
  if (!Number.isSafeInteger(m.bytes) || !Number.isSafeInteger(m.depth)) return false;
  if (!Array.isArray(m.segments)) return false;
  // Every other field the panel shows or joins by is a string where it is there at all. A number or
  // an object under one of these reaches the page as whatever printing it produces, and the
  // Sessionizer's own decoder refuses the record rather than carry it.
  for (const name of ['src', 'chain', 'why', 'model', 'session', 'run', 'call', 'request', 'previous_request'] as const) {
    if (m[name] !== undefined && typeof m[name] !== 'string') return false;
  }
  for (const seg of m.segments) {
    if (!seg || typeof seg !== 'object') return false;
    if (seg.lit !== undefined && typeof seg.lit !== 'string') return false;
    if (seg.piece !== undefined && typeof seg.piece !== 'string') return false;
    if (seg.part !== undefined && seg.part !== null && !Number.isSafeInteger(seg.part)) return false;
    if (seg.copy !== undefined) {
      const c = seg.copy;
      if (!c || typeof c !== 'object') return false;
      if (typeof c.from !== 'string' || typeof c.sha256 !== 'string' || !Number.isSafeInteger(c.len)) return false;
    }
  }
  return true;
}

/** Why a body could not be rebuilt, in the reader's words. */
export class PromptError extends Error {}

/**
 * What happened to one record. `unresolved` is the one that can change: the record refers to another
 * the session has not read yet, and reading the file it is in makes this record readable.
 */
type AddOutcome = 'added' | 'refused' | 'unresolved';

/**
 * The provider bodies of one session. Records are added in landing order: seq, then row. A record whose
 * references the session cannot answer is refused, so a body either rebuilds to its digest or says why
 * it cannot.
 */
export class PromptStore {
  private readonly records = new Map<string, PromptRecord>();
  private readonly byPosition = new Map<string, PromptRecord>();
  /** The record and part holding each piece, by the piece's sha256. */
  private readonly pieces = new Map<string, { id: string; part: number }>();
  private readonly cache = new Map<string, Uint8Array>();
  private readonly cacheOrder: string[] = [];
  private cacheBytes = 0;
  /** The seqs whose files were added, so a reader knows what it still needs. */
  readonly loaded = new Set<number>();

  /** Whether the file of that seq was added already. */
  has(seq: number): boolean {
    return this.loaded.has(seq);
  }

  /**
   * Adds one file's records, in line order. A record already held is left as it is.
   *
   * The file counts as held only when nothing in it waited on a record this session does not have.
   * A body refers to bodies that landed before it, so a file read out of order loses those records;
   * reading the earlier file later must bring this one back, and it cannot if the file is held.
   */
  addFile(file: StoredFile): void {
    let waiting = false;
    for (const record of readProviderFile(file.seq, file.bytes)) {
      if (this.add(record) === 'unresolved') waiting = true;
    }
    if (waiting) this.loaded.delete(file.seq);
    else this.loaded.add(file.seq);
  }

  /** The manifest of the body at a landed position, or null when it is not held. */
  manifestAt(seq: number, row: number): PromptManifest | null {
    return this.byPosition.get(`${seq}/${row}`)?.manifest ?? null;
  }

  /** The body at a landed position. Throws a PromptError when it is not held or does not rebuild. */
  bodyAt(seq: number, row: number): Uint8Array {
    const record = this.byPosition.get(`${seq}/${row}`);
    if (!record) throw new PromptError(`no body landed at seq ${seq} row ${row}`);
    return this.body(record.id);
  }

  /** The body held under a record id. */
  body(id: string): Uint8Array {
    const held = this.cache.get(id);
    if (held) return held;
    const record = this.records.get(id);
    if (!record) throw new PromptError(`no body ${id}`);
    const bytes = this.rebuild(record);
    this.remember(id, bytes);
    return bytes;
  }

  /** The record a response with that provider request id carries, or null. */
  responseOfRequestId(requestId: string): PromptRecord | null {
    for (const r of this.records.values()) {
      if (r.manifest.role === ROLE_RESPONSE && r.manifest.request === requestId) return r;
    }
    return null;
  }

  private add(record: PromptRecord): AddOutcome {
    const m = record.manifest;
    if (m.bytes < 0 || m.bytes > MAX_BODY_BYTES || m.depth < 0 || m.depth > MAX_DEPTH) return 'refused';
    const own = record.parts.length - 1;
    let copies = 0;
    for (const seg of m.segments ?? []) {
      if (seg.part != null) {
        if (seg.part < 0 || seg.part >= own) return 'refused';
      } else if (seg.piece) {
        if (!this.pieces.has(seg.piece)) return 'unresolved';
      } else if (seg.copy) {
        copies++;
        const base = this.records.get(seg.copy.from);
        if (!base) return 'unresolved';
        if (base.manifest.sha256 !== seg.copy.sha256 || seg.copy.len < 0 || seg.copy.len > base.manifest.bytes) return 'refused';
        if (m.depth !== base.manifest.depth + 1 || m.depth > MAX_DEPTH) return 'refused';
      }
    }
    if (copies === 0 && m.depth !== 0) return 'refused';
    const already = this.records.get(record.id);
    if (already) {
      // A record landed twice by an interrupted pass is one body. Both must say the same thing, and
      // the one arriving now is rebuilt to prove it: a digest it claims is not evidence of itself.
      if (already.manifest.sha256 !== m.sha256 || already.manifest.bytes !== m.bytes) return 'refused';
      try {
        if (sha256Hex(this.rebuild(record)) !== m.sha256) return 'refused';
      } catch {
        return 'refused';
      }
      this.byPosition.set(`${record.seq}/${record.row}`, already);
      return 'added';
    }
    this.records.set(record.id, record);
    this.byPosition.set(`${record.seq}/${record.row}`, record);
    for (let i = 0; i < own; i++) {
      const part = record.parts[i]!;
      if (part.kind !== 'data' || part.raw === null) continue;
      const d = sha256Hex(encoder.encode(part.raw));
      if (!this.pieces.has(d)) this.pieces.set(d, { id: record.id, part: i });
    }
    return 'added';
  }

  private rebuild(record: PromptRecord): Uint8Array {
    const m = record.manifest;
    if (m.bytes < 0 || m.bytes > MAX_BODY_BYTES) throw new PromptError(`${record.id} claims ${m.bytes} bytes`);
    const out = new Uint8Array(m.bytes);
    let at = 0;
    const take = (bytes: Uint8Array): void => {
      if (at + bytes.length > m.bytes) throw new PromptError(`${record.id} rebuilds past the ${m.bytes} bytes it claims`);
      out.set(bytes, at);
      at += bytes.length;
    };
    for (const seg of m.segments ?? []) {
      if (seg.lit) {
        take(encoder.encode(seg.lit));
      } else if (seg.part != null) {
        if (seg.part < 0 || seg.part >= record.parts.length - 1) {
          throw new PromptError(`${record.id} names part ${seg.part} it does not have`);
        }
        take(partBytes(record.parts[seg.part]!));
      } else if (seg.piece) {
        const at2 = this.pieces.get(seg.piece);
        if (!at2) throw new PromptError(`${record.id} names a piece no earlier record holds`);
        take(partBytes(this.records.get(at2.id)!.parts[at2.part]!));
      } else if (seg.copy) {
        const base = this.body(seg.copy.from);
        if (seg.copy.len < 0 || seg.copy.len > base.length) {
          throw new PromptError(`${record.id} copies ${seg.copy.len} bytes of a ${base.length} byte body`);
        }
        take(base.subarray(0, seg.copy.len));
      }
    }
    if (at !== m.bytes || sha256Hex(out) !== m.sha256) {
      throw new PromptError(`${record.id} rebuilds to ${at} bytes that do not match its digest`);
    }
    return out;
  }

  private remember(id: string, bytes: Uint8Array): void {
    this.cache.set(id, bytes);
    this.cacheOrder.push(id);
    this.cacheBytes += bytes.length;
    while (this.cacheBytes > CACHE_LIMIT && this.cacheOrder.length > 1) {
      const old = this.cacheOrder.shift()!;
      this.cacheBytes -= this.cache.get(old)?.length ?? 0;
      this.cache.delete(old);
    }
  }
}

/** A part's bytes: its data as the line spells it, or an unknown part's own bytes. */
function partBytes(part: Part): Uint8Array {
  if (part.raw === null) throw new PromptError('a part without data');
  if (part.kind !== 'unknown') return encoder.encode(part.raw);
  const text = JSON.parse(part.raw) as unknown;
  if (typeof text !== 'string') throw new PromptError("an unknown part's data is not one JSON string");
  if (!part.encoding) return encoder.encode(text);
  if (part.encoding === 'base64') {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  throw new PromptError(`unknown part encoding ${part.encoding}`);
}

/** The lines of a file, without their newline. A JSON string never holds a raw newline, so a record
 *  line ends at the first one. */
function splitLines(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let from = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      out.push(bytes.subarray(from, i));
      from = i + 1;
    }
  }
  if (from < bytes.length) out.push(bytes.subarray(from));
  return out;
}

/**
 * The raw `data` text of each element of a record line's `parts` array, in order, null for a part
 * without one. A walk over the line's syntax, not a parse: it needs only where each value starts and
 * ends, so the bytes a part carries reach the body unchanged.
 */
export function rawPartData(line: string): Array<string | null> {
  let pos = 0;
  const peek = (): string => line.charAt(pos);
  const skipSpace = (): void => {
    while (pos < line.length && ' \t\r\n'.includes(line.charAt(pos))) pos++;
  };
  const expect = (c: string): void => {
    if (line.charAt(pos) !== c) throw new PromptError(`expected ${c} at ${pos}`);
    pos++;
  };
  const string = (): string => {
    expect('"');
    let out = '';
    for (;;) {
      const c = line.charAt(pos++);
      if (c === '"') return out;
      if (c === '\\') {
        const e = line.charAt(pos++);
        if (e === 'u') {
          out += String.fromCharCode(parseInt(line.slice(pos, pos + 4), 16));
          pos += 4;
        } else {
          out += e;
        }
      } else {
        out += c;
      }
    }
  };
  const skipValue = (): void => {
    const c = peek();
    if (c === '"') {
      string();
    } else if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      pos++;
      for (;;) {
        skipSpace();
        if (peek() === close) {
          pos++;
          return;
        }
        if (c === '{') {
          string();
          skipSpace();
          expect(':');
          skipSpace();
        }
        skipValue();
        skipSpace();
        if (peek() === ',') pos++;
      }
    } else {
      while (pos < line.length && !',}] \t\r\n'.includes(line.charAt(pos))) pos++;
    }
  };
  const partDataOf = (): string | null => {
    let data: string | null = null;
    expect('{');
    for (;;) {
      skipSpace();
      if (peek() === '}') {
        pos++;
        return data;
      }
      const key = string();
      skipSpace();
      expect(':');
      skipSpace();
      const start = pos;
      skipValue();
      if (key === 'data') data = line.slice(start, pos);
      skipSpace();
      if (peek() === ',') pos++;
    }
  };
  const out: Array<string | null> = [];
  try {
    skipSpace();
    expect('{');
    for (;;) {
      skipSpace();
      if (peek() === '}') return out;
      const key = string();
      skipSpace();
      expect(':');
      skipSpace();
      if (key === 'parts' && peek() === '[') {
        // A record naming `parts` twice is what its last one says, which is what a JSON reader
        // keeps and what the record's own manifest was written against.
        out.length = 0;
        pos++;
        for (;;) {
          skipSpace();
          if (peek() === ']') {
            pos++;
            break;
          }
          out.push(partDataOf());
          skipSpace();
          if (peek() === ',') pos++;
        }
      } else {
        skipValue();
      }
      skipSpace();
      if (peek() === ',') pos++;
    }
  } catch {
    return out;
  }
}
