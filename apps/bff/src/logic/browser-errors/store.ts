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
 * Process-global, in-memory store of JS source maps used to de-obfuscate
 * BROWSER-layer error stacks (#6784). There is deliberately NO OAP-side
 * storage — this is a per-BFF-instance cache, and the budgets make it
 * explicitly evictable so a busy operator can't OOM the relay.
 *
 * Two provisioning paths, with different durability:
 *   - `upload` — a `.map` POSTed at runtime. Held in memory only: counts
 *     against the byte/count budget, is LRU-evicted under pressure, and
 *     is gone on restart. This is the "temporary" set the UI warns about.
 *   - `mount`  — a `.map` discovered at boot under `bootMountDir`. Indexed
 *     (id + path + size) but NOT held resident; read from disk on demand
 *     and dropped from the parsed cache freely. Durable across restarts,
 *     and not deletable from the UI.
 *
 * Resolution itself lives in `resolve.ts` (pure). This module only owns
 * bytes, eviction, disk IO, and a small parsed-map cache.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { TraceMap } from '@jridgewell/trace-mapping';
import type {
  SourceMapDescriptor,
  SourceMapOrigin,
  SourceMapUsage,
} from '@skywalking-horizon-ui/api-client';
import { logger } from '../../logger.js';

export interface SourceMapStoreOptions {
  enabled: boolean;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFileCount: number;
}

/** Parsed maps run larger than their raw bytes and are only needed during
 *  an active resolve, so they ride a small LRU bounded BOTH by this count
 *  AND by `maxTotalBytes` (using each map's raw bytes as the proxy for its
 *  parsed footprint). That keeps repeated resolves from growing the heap
 *  past the configured budget while the usage bar shows only raw bytes. */
const PARSED_CACHE_MAX = 8;

interface Entry {
  id: string;
  label: string;
  origin: SourceMapOrigin;
  bytes: number;
  addedAt: number;
  lastUsedAt: number;
  /** Resident map JSON. Always set for uploads; null for mounts (lazy). */
  raw: string | null;
  /** Source path, mounts only. */
  mountPath?: string;
}

export type UploadResult =
  | { ok: true; map: SourceMapDescriptor }
  | { ok: false; error: 'disabled' | 'too_large' | 'invalid_map' | 'no_file' };

function descriptorOf(e: Entry): SourceMapDescriptor {
  return {
    id: e.id,
    label: e.label,
    origin: e.origin,
    bytes: e.bytes,
    addedAt: e.addedAt,
    lastUsedAt: e.lastUsedAt,
  };
}

/** Cheap structural check that a buffer is a Source Map v3 document.
 *  Returns the decoded JSON on success so callers don't parse twice. */
function validateSourceMap(text: string): Record<string, unknown> | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (obj.version !== 3) return null;
  if (typeof obj.mappings !== 'string') return null;
  return obj;
}

export class SourceMapStore {
  /** Config is read through a live getter so `sourceMaps.enabled` + the
   *  budgets hot-reload with horizon.yaml (the repo's general contract).
   *  CAVEAT: the multipart upload hard-cap is registered once at boot in
   *  server.ts, so RAISING `maxFileBytes` at runtime only takes effect for
   *  the in-memory budget — an upload above the startup cap still needs a
   *  restart. Lowering it, and toggling `enabled`, take effect live. */
  private readonly cfg: () => SourceMapStoreOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly parsed = new Map<string, TraceMap>();

  constructor(cfg: () => SourceMapStoreOptions) {
    this.cfg = cfg;
  }

  get enabled(): boolean {
    return this.cfg().enabled;
  }

  /** Bytes currently resident in memory — uploads (always resident) only.
   *  Mounts are disk-backed and don't count against the runtime budget. */
  private residentUploadBytes(): number {
    let sum = 0;
    for (const e of this.entries.values()) if (e.origin === 'upload') sum += e.bytes;
    return sum;
  }

  private uploadCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.origin === 'upload') n++;
    return n;
  }

  private mountCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.origin === 'mount') n++;
    return n;
  }

  /** Sum of the RAW bytes of the maps currently held parsed — the proxy
   *  used to bound the parsed cache against `maxTotalBytes`. */
  private parsedRawBytes(): number {
    let sum = 0;
    for (const id of this.parsed.keys()) sum += this.entries.get(id)?.bytes ?? 0;
    return sum;
  }

  /** Evict least-recently-used UPLOADS until adding `incomingBytes` keeps
   *  both the byte budget and the count cap. Mounts are never evicted
   *  (they reload from disk). */
  private evictForUpload(incomingBytes: number): void {
    const o = this.cfg();
    const overBudget = (): boolean =>
      this.residentUploadBytes() + incomingBytes > o.maxTotalBytes;
    const overCount = (): boolean => this.uploadCount() + 1 > o.maxFileCount;
    while (overBudget() || overCount()) {
      let victim: Entry | null = null;
      for (const e of this.entries.values()) {
        if (e.origin !== 'upload') continue;
        if (!victim || e.lastUsedAt < victim.lastUsedAt) victim = e;
      }
      if (!victim) break;
      this.drop(victim.id);
    }
  }

  private drop(id: string): void {
    this.entries.delete(id);
    this.parsed.delete(id);
  }

  /** Trim resident uploads (LRU) + the parsed cache down to the CURRENT
   *  budgets. Called on the read paths so a hot-reload that LOWERS a budget
   *  takes effect on the next interaction (eviction otherwise only ran on
   *  upload). */
  private enforceBudget(): void {
    const o = this.cfg();
    while (this.residentUploadBytes() > o.maxTotalBytes || this.uploadCount() > o.maxFileCount) {
      let victim: Entry | null = null;
      for (const e of this.entries.values()) {
        if (e.origin !== 'upload') continue;
        if (!victim || e.lastUsedAt < victim.lastUsedAt) victim = e;
      }
      if (!victim) break;
      this.drop(victim.id);
    }
    while (this.parsed.size > PARSED_CACHE_MAX || (this.parsed.size > 0 && this.parsedRawBytes() > o.maxTotalBytes)) {
      const oldest = this.parsed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.parsed.delete(oldest);
    }
  }

  /** Add (or refresh) an uploaded map. Id is content-addressed so the
   *  same file re-uploaded dedups rather than piling up. */
  addUpload(label: string, content: Buffer | string): UploadResult {
    const o = this.cfg();
    if (!o.enabled) return { ok: false, error: 'disabled' };
    const text = typeof content === 'string' ? content : content.toString('utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes === 0) return { ok: false, error: 'no_file' };
    // Reject anything that can't fit the budget at all — a single file
    // larger than maxFileBytes, or (even alone) larger than maxTotalBytes.
    if (bytes > o.maxFileBytes || bytes > o.maxTotalBytes) return { ok: false, error: 'too_large' };
    if (!validateSourceMap(text)) return { ok: false, error: 'invalid_map' };

    const id = createHash('sha1').update(text).digest('hex').slice(0, 12);
    const now = Date.now();
    const existing = this.entries.get(id);
    if (existing) {
      existing.lastUsedAt = now;
      existing.label = label || existing.label;
      return { ok: true, map: descriptorOf(existing) };
    }
    this.evictForUpload(bytes);
    const entry: Entry = {
      id,
      label: label || `${id}.map`,
      origin: 'upload',
      bytes,
      addedAt: now,
      lastUsedAt: now,
      raw: text,
    };
    this.entries.set(id, entry);
    return { ok: true, map: descriptorOf(entry) };
  }

  /** Scan `dir` for `.map` files and index them as durable `mount`
   *  entries. Each candidate is read + validated as Source Map v3 at index
   *  time so only real maps surface in the UI (an invalid file used to
   *  appear and only fail at resolve). `maxFileCount` bounds the mounted
   *  set too — once hit, the rest are skipped with a warning (the operator
   *  controls the directory; this just bounds boot I/O + the list). The
   *  validated content is NOT retained — mounts stay disk-backed and are
   *  re-read lazily on resolve, so they don't occupy the byte budget.
   *  Tolerant: a missing dir is a no-op. Safe to call once at boot. */
  async loadMountDir(dir: string): Promise<void> {
    const o = this.cfg();
    if (!o.enabled || !dir) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info({ dir }, 'source-map mount dir absent; skipping static load');
        return;
      }
      logger.warn({ err, dir }, 'source-map mount dir unreadable');
      return;
    }
    let loaded = 0;
    let skipped = 0;
    for (const name of names) {
      if (!name.endsWith('.map')) continue;
      if (this.mountCount() >= o.maxFileCount) {
        skipped++;
        continue;
      }
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        if (info.size > o.maxFileBytes) {
          logger.warn({ path, size: info.size, cap: o.maxFileBytes }, 'mounted source map exceeds maxFileBytes; skipping');
          continue;
        }
        const text = await readFile(path, 'utf8');
        if (!validateSourceMap(text)) {
          logger.warn({ path }, 'mounted file is not a valid Source Map v3; skipping');
          continue;
        }
        const id = createHash('sha1').update(`mount:${path}`).digest('hex').slice(0, 12);
        const now = Date.now();
        this.entries.set(id, {
          id,
          label: basename(name),
          origin: 'mount',
          bytes: info.size,
          addedAt: now,
          lastUsedAt: now,
          raw: null,
          mountPath: path,
        });
        loaded++;
      } catch (err) {
        logger.warn({ err, path }, 'failed to index mounted source map');
      }
    }
    if (loaded > 0 || skipped > 0) {
      logger.info({ dir, loaded, skipped }, 'indexed statically-mounted source maps');
    }
  }

  list(): SourceMapDescriptor[] {
    this.enforceBudget();
    return [...this.entries.values()]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map(descriptorOf);
  }

  usage(): SourceMapUsage {
    this.enforceBudget();
    const o = this.cfg();
    return {
      usedBytes: this.residentUploadBytes(),
      maxTotalBytes: o.maxTotalBytes,
      maxFileBytes: o.maxFileBytes,
      maxFileCount: o.maxFileCount,
    };
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  labelOf(id: string): string | null {
    return this.entries.get(id)?.label ?? null;
  }

  /** Remove an UPLOADED map. Mounts are durable (reload from disk) and
   *  are not deletable. Returns false if absent or a mount. */
  remove(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.origin === 'mount') return false;
    this.drop(id);
    return true;
  }

  /** Parse (and cache) the map for `id`, reading a mount file from disk on
   *  demand. Touches `lastUsedAt` so the LRU reflects real usage. Returns
   *  null when the id is unknown or the source is unreadable/invalid. */
  async getTraceMap(id: string): Promise<TraceMap | null> {
    const e = this.entries.get(id);
    if (!e) return null;
    e.lastUsedAt = Date.now();
    // Apply any hot-reloaded budget lowering. The just-touched entry is now
    // MRU, so it's never the eviction victim here.
    this.enforceBudget();
    if (!this.entries.has(id)) return null;
    const cached = this.parsed.get(id);
    if (cached) {
      this.parsed.delete(id);
      this.parsed.set(id, cached);
      return cached;
    }
    let text = e.raw;
    if (text === null && e.mountPath) {
      try {
        text = await readFile(e.mountPath, 'utf8');
      } catch (err) {
        logger.warn({ err, path: e.mountPath }, 'failed to read mounted source map');
        return null;
      }
    }
    if (!text) return null;
    let map: TraceMap;
    try {
      map = new TraceMap(text);
    } catch (err) {
      logger.warn({ err, id }, 'failed to parse source map');
      return null;
    }
    this.parsed.set(id, map);
    // Bound the parsed cache by count AND by the raw-byte budget (raw size
    // as the proxy for parsed footprint), so repeated resolves can't grow
    // the heap past maxTotalBytes. Never evict the entry we just inserted.
    const maxTotal = this.cfg().maxTotalBytes;
    while (this.parsed.size > 1 && (this.parsed.size > PARSED_CACHE_MAX || this.parsedRawBytes() > maxTotal)) {
      const oldest = this.parsed.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === id) break;
      this.parsed.delete(oldest);
    }
    return map;
  }
}
