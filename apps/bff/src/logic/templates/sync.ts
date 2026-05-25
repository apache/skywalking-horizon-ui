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
 * OAP UI-template sync orchestrator.
 *
 * Two entry points:
 *   - `bootSeed()` runs ONCE at BFF startup. It lists OAP templates, seeds
 *     any bundled template that's missing on OAP (this is the only path
 *     that writes-on-absence), then returns the merged status.
 *   - `getSyncStatus()` runs on-demand (every `/api/configs/bundle` hit).
 *     30-second single-flight cache; pure read against OAP. Never writes,
 *     even when remote is missing — operator action is required.
 *
 * When the admin port is unreachable:
 *   - `bootSeed()` logs a warning and returns `unreachable: true` so the
 *     server still finishes boot.
 *   - `getSyncStatus()` returns `unreachable: true` so the UI shows the
 *     read-only banner; render falls back to bundled.
 *
 * Equality is byte-exact on the canonicalized envelope (see `names.ts`).
 * OAP stores the configuration string verbatim, so a round-trip without
 * operator edit produces the same string.
 */

import type { Logger } from 'pino';
import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import {
  buildEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type TemplateKind,
} from './names.js';

export interface BundledTemplate {
  kind: TemplateKind;
  /** The key portion of the name (e.g. `services`, `GENERAL`, `page-setup`). */
  key: string;
  /** Inner content. The orchestrator wraps this in the standard envelope. */
  content: unknown;
}

export type TemplateStatus =
  | 'synced'           // bundled present, remote present, byte-equal, not disabled
  | 'diverged'         // both present, NOT byte-equal
  | 'disabled'         // remote present but disabled — UI hides, no render
  | 'remote-only'      // remote present, no bundled match (operator added or Horizon dropped it)
  | 'bundled-fallback' // bundled present, remote absent at runtime (NOT seeded post-boot)
  | 'unknown';         // shouldn't happen — defensive

export interface TemplateRow {
  name: string;
  kind: TemplateKind;
  key: string;
  status: TemplateStatus;
  /** What the renderer should use. `null` for `disabled`. */
  effective: 'remote' | 'bundled' | null;
  /** Remote-side detail. `null` when remote-absent. */
  remote: { id: string; configuration: string; disabled: boolean } | null;
  /** Bundled-side serialized envelope. `null` when bundled-absent (`remote-only`). */
  bundled: { configuration: string } | null;
}

export interface SyncStatus {
  /** When true, OAP admin was unreachable at the time this status was
   *  computed. `rows` will be a bundled-only view (every bundled row marked
   *  `bundled-fallback`, no remote info). */
  unreachable: boolean;
  /** Epoch ms of the most-recent successful OAP probe. `null` when we
   *  have never reached OAP since process start. */
  lastSuccessfulSyncAt: number | null;
  /** When this status snapshot was generated. */
  generatedAt: number;
  rows: TemplateRow[];
}

export interface SyncDeps {
  client: UITemplateClient;
  /** Pull every bundled template the BFF currently has loaded. */
  bundled: () => Iterable<BundledTemplate>;
  logger: Logger;
  now?: () => number;
}

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  at: number;
  status: SyncStatus;
}

/** Single-flight cache. Module-level state — one BFF process, one cache. */
let cache: CacheEntry | null = null;
let inFlight: Promise<SyncStatus> | null = null;
let lastSuccessfulSyncAt: number | null = null;

export function invalidateSyncCache(): void {
  cache = null;
}

/** On-demand sync. Honors the 30s cache + single-flight. Never writes. */
export async function getSyncStatus(deps: SyncDeps): Promise<SyncStatus> {
  const now = (deps.now ?? Date.now)();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.status;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const status = await runOnce(deps, { write: false });
      cache = { at: (deps.now ?? Date.now)(), status };
      return status;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Boot-time sync: lists OAP, seeds any bundled template missing on OAP,
 *  then re-lists to produce the merged status. This is the only path that
 *  writes implicitly. Failures are non-fatal — boot continues, the UI
 *  falls back to bundled. */
export async function bootSeed(deps: SyncDeps): Promise<SyncStatus> {
  const status = await runOnce(deps, { write: true });
  cache = { at: (deps.now ?? Date.now)(), status };
  return status;
}

/** Force the next caller of `getSyncStatus` to re-list OAP. No I/O here. */
export function resync(): void {
  invalidateSyncCache();
}

interface RunOptions {
  /** When true, POST any bundled-only template back to OAP before
   *  building the final status (boot seed). */
  write: boolean;
}

async function runOnce(deps: SyncDeps, opts: RunOptions): Promise<SyncStatus> {
  const now = (deps.now ?? Date.now)();
  const bundledRows = buildBundledRows(deps.bundled());

  let oapRows;
  try {
    oapRows = await deps.client.list();
  } catch (err) {
    deps.logger.warn(
      { err: errMsg(err), action: opts.write ? 'boot-seed' : 'runtime-sync' },
      'OAP UI-template list failed — rendering bundled, admin read-only',
    );
    return {
      unreachable: true,
      lastSuccessfulSyncAt,
      generatedAt: now,
      rows: bundledOnlyRows(bundledRows, 'bundled-fallback'),
    };
  }

  lastSuccessfulSyncAt = (deps.now ?? Date.now)();
  const parsedRemote = parseRemoteRows(oapRows, deps.logger);

  if (opts.write) {
    const seedCount = await seedMissing(deps, bundledRows, parsedRemote);
    if (seedCount > 0) {
      // Re-list so the merged view reflects the freshly-seeded UUIDs.
      try {
        const refreshed = await deps.client.list();
        parsedRemote.clear();
        for (const [k, v] of parseRemoteRows(refreshed, deps.logger)) parsedRemote.set(k, v);
        deps.logger.info({ seedCount }, 'OAP UI-template boot seed complete');
      } catch (err) {
        deps.logger.warn(
          { err: errMsg(err) },
          'OAP UI-template re-list after seed failed — sync status may lag the next runtime pull',
        );
      }
    }
  }

  const rows = mergeRows(bundledRows, parsedRemote);
  return {
    unreachable: false,
    lastSuccessfulSyncAt,
    generatedAt: now,
    rows,
  };
}

interface BundledRow {
  name: string;
  kind: TemplateKind;
  key: string;
  configuration: string;
  content: unknown;
}

interface RemoteRow {
  name: string;
  kind: TemplateKind;
  key: string;
  id: string;
  configuration: string;
  disabled: boolean;
}

function buildBundledRows(bundled: Iterable<BundledTemplate>): Map<string, BundledRow> {
  const out = new Map<string, BundledRow>();
  for (const b of bundled) {
    const envelope = buildEnvelope(b.kind, b.key, b.content);
    out.set(envelope.name, {
      name: envelope.name,
      kind: b.kind,
      key: b.key,
      configuration: serializeEnvelope(envelope),
      content: b.content,
    });
  }
  return out;
}

function parseRemoteRows(
  rows: Array<{ id: string; configuration: string; disabled: boolean }>,
  logger: Logger,
): Map<string, RemoteRow> {
  const out = new Map<string, RemoteRow>();
  let skipped = 0;
  /* OAP enforces uniqueness on the storage UUID, NOT on the inner
   * envelope `name`. A name collision happens whenever a template was
   * disabled (soft-delete) then re-created from the bundled default —
   * the old disabled row sticks around alongside the new enabled one,
   * both claiming `horizon.layer.<KEY>`. The order OAP returns them in
   * isn't stable, so a naive `.set(name, row)` flips the rendered
   * state every other fetch (the symptom: a layer apparently toggling
   * between disabled and synced under steady-state).
   *
   * Resolution: prefer the row that's NOT disabled. The enabled record
   * is what an operator would consider "live"; the disabled one is a
   * tombstone that OAP can't delete because the UI-template REST
   * surface has no DELETE. Ties (both disabled, or both enabled) fall
   * to first-seen — deterministic but rare. */
  const duplicates: string[] = [];
  for (const r of rows) {
    const env = parseEnvelope(r.configuration);
    if (!env) {
      skipped++;
      continue;
    }
    const existing = out.get(env.name);
    const candidate: RemoteRow = {
      name: env.name,
      kind: env.kind,
      key: env.name.split('.').slice(2).join('.'),
      id: r.id,
      configuration: r.configuration,
      disabled: r.disabled,
    };
    if (!existing) {
      out.set(env.name, candidate);
      continue;
    }
    // Collision: prefer enabled over disabled. Otherwise keep existing
    // (first-seen wins among same-disabled rows).
    duplicates.push(env.name);
    if (existing.disabled && !candidate.disabled) {
      out.set(env.name, candidate);
    }
  }
  if (skipped > 0) {
    logger.debug(
      { skipped },
      'OAP UI-template rows ignored (not Horizon-namespaced) — operator may have other tools writing to this OAP',
    );
  }
  if (duplicates.length > 0) {
    logger.warn(
      { names: Array.from(new Set(duplicates)) },
      'OAP UI-template duplicate names — kept the enabled row per name; operator should manually consolidate via OAP admin',
    );
  }
  return out;
}

async function seedMissing(
  deps: SyncDeps,
  bundled: Map<string, BundledRow>,
  remote: Map<string, RemoteRow>,
): Promise<number> {
  let count = 0;
  for (const [name, b] of bundled) {
    if (remote.has(name)) continue;
    try {
      const ack = await deps.client.create(b.configuration);
      if (!ack.status) {
        deps.logger.warn(
          { name, message: ack.message },
          'OAP UI-template seed rejected — name conflict on OAP side, manual reconcile needed',
        );
        continue;
      }
      count++;
      deps.logger.info({ name, id: ack.id }, 'OAP UI-template seeded');
    } catch (err) {
      deps.logger.warn(
        { name, err: errMsg(err) },
        'OAP UI-template seed failed — will retry at next BFF boot',
      );
    }
  }
  return count;
}

function mergeRows(
  bundled: Map<string, BundledRow>,
  remote: Map<string, RemoteRow>,
): TemplateRow[] {
  const out: TemplateRow[] = [];
  const seen = new Set<string>();

  for (const [name, b] of bundled) {
    seen.add(name);
    const r = remote.get(name);
    if (!r) {
      out.push({
        name,
        kind: b.kind,
        key: b.key,
        status: 'bundled-fallback',
        effective: 'bundled',
        remote: null,
        bundled: { configuration: b.configuration },
      });
      continue;
    }
    if (r.disabled) {
      out.push({
        name,
        kind: b.kind,
        key: b.key,
        status: 'disabled',
        effective: null,
        remote: { id: r.id, configuration: r.configuration, disabled: true },
        bundled: { configuration: b.configuration },
      });
      continue;
    }
    const status = r.configuration === b.configuration ? 'synced' : 'diverged';
    out.push({
      name,
      kind: b.kind,
      key: b.key,
      status,
      effective: 'remote',
      remote: { id: r.id, configuration: r.configuration, disabled: false },
      bundled: { configuration: b.configuration },
    });
  }

  for (const [name, r] of remote) {
    if (seen.has(name)) continue;
    out.push({
      name,
      kind: r.kind,
      key: r.key,
      status: r.disabled ? 'disabled' : 'remote-only',
      effective: r.disabled ? null : 'remote',
      remote: { id: r.id, configuration: r.configuration, disabled: r.disabled },
      bundled: null,
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function bundledOnlyRows(bundled: Map<string, BundledRow>, status: TemplateStatus): TemplateRow[] {
  return Array.from(bundled.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((b) => ({
      name: b.name,
      kind: b.kind,
      key: b.key,
      status,
      effective: 'bundled' as const,
      remote: null,
      bundled: { configuration: b.configuration },
    }));
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
