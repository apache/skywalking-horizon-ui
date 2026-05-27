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
  buildOverlayEnvelope,
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
  /** Set on per-locale translation overlay rows (`…i18n.<locale>`),
   *  unset on source rows. Source consumers (bundle render, admin
   *  layer / overview pages) filter to `locale === undefined`. */
  locale?: string;
  status: TemplateStatus;
  /** What the renderer should use. `null` for `disabled`. */
  effective: 'remote' | 'bundled' | null;
  /** Remote-side detail. `null` when remote-absent. */
  remote: { id: string; configuration: string; disabled: boolean } | null;
  /** Bundled-side serialized envelope. `null` when bundled-absent (`remote-only`). */
  bundled: { configuration: string } | null;
}

export interface ConflictRow {
  /** Envelope name (e.g. `horizon.layer.ACTIVEMQ`) seen on >1 enabled
   *  OAP record. The BFF picks the lowest-id row as the live one and
   *  surfaces this list so the operator can disable the extras. */
  name: string;
  kind: TemplateKind;
  key: string;
  /** UUIDs of every enabled OAP row that shares this name, sorted
   *  ASC so picks are deterministic across BFF instances. The first
   *  element is the winner; the rest are losers. */
  enabledIds: string[];
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
  /** Per-name multi-enabled conflicts — extras the dedup couldn't auto-
   *  collapse (e.g. byte-different configurations). Empty list = no
   *  conflicts. The admin UI renders a banner per entry. */
  conflicts: ConflictRow[];
}

export interface BundledOverlay {
  kind: TemplateKind;
  key: string;
  locale: string;
  /** The translation overlay's content — same shape as the source's
   *  translatable leaves. Empty / missing overlays are filtered by the
   *  iterator before they reach here. */
  content: unknown;
}

export interface SyncDeps {
  client: UITemplateClient;
  /** Pull every bundled template the BFF currently has loaded. */
  bundled: () => Iterable<BundledTemplate>;
  /** Pull every per-locale translation overlay the BFF ships on disk.
   *  bootSeed creates a sibling OAP row for each one that doesn't
   *  already have an OAP overlay row, so operators see "what was
   *  shipped" as their diff baseline in the Translations editor. */
  bundledOverlays?: () => Iterable<BundledOverlay>;
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

/**
 * Block until OAP admin is reachable, then return. Uses `client.list()`
 * as the readiness check (same call bootSeed itself runs first, so a
 * success here proves the seed can proceed). Backs off 1s → 2s → 4s
 * → … capped at 60s so a slow OAP startup doesn't pin the loop on the
 * fast end; each failed attempt emits one warn line so an operator
 * grepping logs sees the wait progress.
 *
 * Why we wait here instead of letting `bootSeed` fall through on the
 * first failure: when OAP and Horizon start in the same compose / k8s
 * rollout, OAP's admin module often binds after the BFF process is
 * already up. The old behaviour was a single attempt → warn → no
 * retry → no templates ever pushed for that BFF lifetime. This
 * function fixes the race without introducing any steady-state
 * polling: once `list()` succeeds we return, the seed runs once,
 * we never touch the admin port from here again until the operator
 * triggers an admin action.
 *
 * `signal` lets the caller (server boot) cancel the wait on shutdown
 * so the BFF process can exit cleanly even mid-backoff.
 */
const READINESS_INITIAL_DELAY_MS = 1000;
const READINESS_MAX_DELAY_MS = 60_000;

export async function waitForOapAdminReady(
  deps: SyncDeps,
  signal?: AbortSignal,
): Promise<void> {
  let delay = READINESS_INITIAL_DELAY_MS;
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) return;
    attempt++;
    try {
      await deps.client.list();
      if (attempt > 1) {
        deps.logger.info({ attempt }, 'OAP admin reachable — proceeding with boot seed');
      }
      return;
    } catch (err) {
      deps.logger.warn(
        { err: errMsg(err), attempt, nextRetryInMs: delay },
        'OAP admin unreachable — retrying readiness check',
      );
    }
    await sleepCancelable(delay, signal);
    delay = Math.min(delay * 2, READINESS_MAX_DELAY_MS);
  }
}

function sleepCancelable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
      conflicts: [],
    };
  }

  lastSuccessfulSyncAt = (deps.now ?? Date.now)();
  let parsedRemote = parseRemoteRows(oapRows, deps.logger);

  if (opts.write) {
    const seedCount = await seedMissing(deps, bundledRows, parsedRemote.byName);
    const overlaySeedCount = await seedMissingOverlays(deps, parsedRemote.byName);
    // Post-seed reconciliation. Any race-created duplicate (peer
    // Horizon instance seeding the same OAP simultaneously, or a
    // BanyanDB read-after-write window that hid an existing row from
    // our seedMissing check) gets collapsed here: enabled wins,
    // identical-content losers are disabled. Self-healing on every
    // boot.
    let disabledDupes: string[] = [];
    try {
      disabledDupes = await reconcileDuplicates(deps, bundledRows);
    } catch (err) {
      deps.logger.warn({ err: errMsg(err) }, 'duplicate reconciliation failed');
    }
    if (seedCount > 0 || overlaySeedCount > 0 || disabledDupes.length > 0) {
      try {
        const refreshed = await deps.client.list();
        parsedRemote = parseRemoteRows(refreshed, deps.logger);
        deps.logger.info(
          { seedCount, overlaySeedCount, collapsedDuplicates: disabledDupes.length },
          'OAP UI-template boot reconcile complete',
        );
      } catch (err) {
        deps.logger.warn(
          { err: errMsg(err) },
          'OAP UI-template re-list after seed failed — sync status may lag the next runtime pull',
        );
      }
    }
  }

  const rows = mergeRows(bundledRows, parsedRemote.byName);
  return {
    unreachable: false,
    lastSuccessfulSyncAt,
    generatedAt: now,
    rows,
    conflicts: parsedRemote.conflicts,
  };
}

/** Thrown when a write to OAP succeeded but the resulting row state
 *  didn't become visible to `list()` within the polling window. Routes
 *  catch this and return 504. */
export class WriteNotVisibleError extends Error {
  readonly kind: 'create' | 'update';
  readonly id: string;
  readonly timeoutMs: number;
  constructor(kind: 'create' | 'update', id: string, timeoutMs: number) {
    super(`OAP ${kind} id=${id} not visible within ${timeoutMs}ms`);
    this.name = 'WriteNotVisibleError';
    this.kind = kind;
    this.id = id;
    this.timeoutMs = timeoutMs;
  }
}
/** Back-compat re-export — the create-specific error type was the
 *  original name. */
export const CreateNotVisibleError = WriteNotVisibleError;

const WRITE_VISIBILITY_TIMEOUT_MS = 5000;

async function pollUntilVisible<T>(
  fetch: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  let delay = 50;
  while (Date.now() < deadline) {
    try {
      const hit = await fetch();
      if (hit !== null) return hit;
    } catch {
      /* transient — retry */
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 500);
  }
  return null;
}

/**
 * Create + wait for the new row to become visible to `client.list()`.
 * Throws {@link WriteNotVisibleError} on timeout.
 */
export async function createAndConfirm(
  client: UITemplateClient,
  configuration: string,
  _logger: Logger,
): Promise<string> {
  // Send the envelope name as the requested id. Required by upstream
  // skywalking#13884 (current OAP rejects POST without an `id`); old
  // OAP releases that auto-generated UUIDs simply ignored the field,
  // so this same payload works on both sides. `ack.id` is the row
  // handle we operate against going forward — same value either way.
  const env = parseEnvelope(configuration);
  const requestedId = env?.name ?? '';
  const ack = await client.create(requestedId, configuration);
  if (!ack.status) {
    throw new Error(`OAP rejected create: ${ack.message || 'no message'}`);
  }
  const id = ack.id;
  const hit = await pollUntilVisible(async () => {
    const rows = await client.list();
    return rows.some((r) => r.id === id) ? id : null;
  }, WRITE_VISIBILITY_TIMEOUT_MS);
  if (hit === null) throw new WriteNotVisibleError('create', id, WRITE_VISIBILITY_TIMEOUT_MS);
  return id;
}

/**
 * Update + wait for the new configuration to become visible to
 * `client.list()`. Same read-after-write guard as createAndConfirm —
 * without this, an immediate re-read can return the OLD content and
 * a follow-up decision races on stale state.
 */
export async function updateAndConfirm(
  client: UITemplateClient,
  id: string,
  configuration: string,
  _logger: Logger,
): Promise<void> {
  const ack = await client.update(id, configuration);
  if (!ack.status) {
    throw new Error(`OAP rejected update: ${ack.message || 'no message'}`);
  }
  const hit = await pollUntilVisible(async () => {
    const rows = await client.list();
    const found = rows.find((r) => r.id === id);
    return found && found.configuration === configuration ? id : null;
  }, WRITE_VISIBILITY_TIMEOUT_MS);
  if (hit === null) throw new WriteNotVisibleError('update', id, WRITE_VISIBILITY_TIMEOUT_MS);
}

/**
 * Disable + wait for `disabled: true` to become visible to
 * `client.list()`. Same read-after-write guard as the other write
 * helpers — keeps subsequent decisions (e.g. reactivate flow,
 * conflict reconcile) from acting on stale state where the row
 * still looks enabled.
 */
export async function disableAndConfirm(
  client: UITemplateClient,
  id: string,
  _logger: Logger,
): Promise<void> {
  const ack = await client.disable(id);
  if (!ack.status) {
    throw new Error(`OAP rejected disable: ${ack.message || 'no message'}`);
  }
  const hit = await pollUntilVisible(async () => {
    const rows = await client.list();
    const found = rows.find((r) => r.id === id);
    return found && found.disabled ? id : null;
  }, WRITE_VISIBILITY_TIMEOUT_MS);
  if (hit === null) throw new WriteNotVisibleError('update', id, WRITE_VISIBILITY_TIMEOUT_MS);
}

/**
 * Group OAP rows by envelope name. For any name with more than one
 * row, keep one and disable the rest. Tie-breaking: enabled wins
 * over disabled; if multiple enabled, prefer the one whose
 * configuration byte-matches the bundled (operator-edited
 * divergences are kept over plain seeds); ties beyond that go to
 * first-seen. Already-disabled losers are left alone (no need to
 * re-disable an existing tombstone).
 *
 * Returns the list of UUIDs the BFF disabled in this pass.
 */
async function reconcileDuplicates(
  deps: SyncDeps,
  bundled: Map<string, BundledRow>,
): Promise<string[]> {
  const rows = await deps.client.list();
  const byName = new Map<string, Array<{ id: string; disabled: boolean; configuration: string }>>();
  for (const r of rows) {
    const env = parseEnvelope(r.configuration);
    if (!env) continue;
    const list = byName.get(env.name) ?? [];
    list.push({ id: r.id, disabled: r.disabled, configuration: r.configuration });
    byName.set(env.name, list);
  }
  const disabled: string[] = [];
  for (const [name, list] of byName) {
    if (list.length <= 1) continue;
    const bundledConfig = bundled.get(name)?.configuration ?? null;
    const enabled = list.filter((r) => !r.disabled);
    // Pick the winner the dedup logic in parseRemoteRows would also
    // pick — bundled-match first, then any enabled, then any.
    let winner = enabled[0] ?? list[0];
    if (bundledConfig) {
      const match = enabled.find((r) => r.configuration === bundledConfig);
      if (match) winner = match;
    }
    for (const r of list) {
      if (r.id === winner.id || r.disabled) continue;
      try {
        await disableAndConfirm(deps.client, r.id, deps.logger);
        deps.logger.info(
          { name, droppedId: r.id, keptId: winner.id },
          'collapsed duplicate UI-template',
        );
        disabled.push(r.id);
      } catch (err) {
        deps.logger.warn(
          { name, id: r.id, err: errMsg(err) },
          'failed to disable duplicate UI-template',
        );
      }
    }
  }
  return disabled;
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
  /** Set on per-locale overlay rows (`…i18n.<locale>`). */
  locale?: string;
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

interface ParsedRemote {
  byName: Map<string, RemoteRow>;
  /** Names where >1 ENABLED row exists. The BFF picks the lowest-id
   *  winner deterministically; the admin UI surfaces the rest. */
  conflicts: ConflictRow[];
}

function parseRemoteRows(
  rows: Array<{ id: string; configuration: string; disabled: boolean }>,
  logger: Logger,
): ParsedRemote {
  /* OAP doesn't enforce uniqueness on envelope name (only on its own
   * storage UUID), so duplicates happen — typically a disabled
   * tombstone + a current enabled record, but occasionally two
   * enabled rows from a concurrent-boot race.
   *
   * Resolution rules:
   *   - Enabled beats disabled.
   *   - Multiple enabled → pick the lowest-id deterministically (so
   *     every BFF instance and every fetch picks the same winner).
   *     Surface the rest as `conflicts` so the admin UI can prompt
   *     a manual reconcile. */
  const groups = new Map<string, Array<RemoteRow>>();
  let skipped = 0;
  for (const r of rows) {
    const env = parseEnvelope(r.configuration);
    if (!env) {
      skipped++;
      continue;
    }
    // For source rows the OAP "key" is whatever the envelope name had
    // after `horizon.<kind>.`. For overlay rows we want the parent
    // template's key, NOT the locale-suffixed string — that's what
    // consumers use to find sibling source rows. The parsed envelope
    // gives us both unambiguously.
    const row: RemoteRow = {
      name: env.name,
      kind: env.kind,
      key: env.locale === undefined
        ? env.name.split('.').slice(2).join('.')
        : env.name.split('.').slice(2, -2).join('.'),
      locale: env.locale,
      id: r.id,
      configuration: r.configuration,
      disabled: r.disabled,
    };
    const list = groups.get(env.name) ?? [];
    list.push(row);
    groups.set(env.name, list);
  }
  const out = new Map<string, RemoteRow>();
  const conflicts: ConflictRow[] = [];
  for (const [name, list] of groups) {
    const enabled = list.filter((r) => !r.disabled).sort((a, b) => a.id.localeCompare(b.id));
    const winner = enabled[0] ?? list.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
    out.set(name, winner);
    if (enabled.length > 1) {
      conflicts.push({
        name,
        kind: winner.kind,
        key: winner.key,
        enabledIds: enabled.map((r) => r.id),
      });
    }
  }
  if (skipped > 0) {
    logger.debug(
      { skipped },
      'OAP UI-template rows ignored (not Horizon-namespaced) — operator may have other tools writing to this OAP',
    );
  }
  if (conflicts.length > 0) {
    logger.warn(
      { conflicts: conflicts.map((c) => ({ name: c.name, ids: c.enabledIds })) },
      'OAP UI-template name conflicts (>1 enabled row) — kept the lowest-id row per name; operator should disable the rest via admin',
    );
  }
  return { byName: out, conflicts };
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
      const id = await createAndConfirm(deps.client, b.configuration, deps.logger);
      count++;
      deps.logger.info({ name, id }, 'OAP UI-template seeded');
    } catch (err) {
      deps.logger.warn(
        { name, err: errMsg(err) },
        'OAP UI-template seed failed — will retry at next BFF boot',
      );
    }
  }
  return count;
}

/** Seed per-locale translation overlay rows from the BFF's disk
 *  catalogs. One row per (kind, key, locale) that has a non-empty
 *  disk overlay AND no existing OAP overlay row. Skipped silently
 *  when the deps don't supply `bundledOverlays` (e.g. older tests). */
async function seedMissingOverlays(
  deps: SyncDeps,
  remote: Map<string, RemoteRow>,
): Promise<number> {
  if (!deps.bundledOverlays) return 0;
  let count = 0;
  for (const ov of deps.bundledOverlays()) {
    const envelope = buildOverlayEnvelope(ov.kind, ov.key, ov.locale, ov.content);
    if (remote.has(envelope.name)) continue;
    const configuration = serializeEnvelope(envelope);
    try {
      const id = await createAndConfirm(deps.client, configuration, deps.logger);
      count++;
      deps.logger.info({ name: envelope.name, id }, 'OAP translation overlay seeded');
    } catch (err) {
      deps.logger.warn(
        { name: envelope.name, err: errMsg(err) },
        'OAP translation overlay seed failed — will retry at next BFF boot',
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
      locale: r.locale,
      status: r.disabled ? 'disabled' : 'remote-only',
      effective: r.disabled ? null : 'remote',
      remote: { id: r.id, configuration: r.configuration, disabled: r.disabled },
      bundled: null,
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Pick the OAP overlay row for the given template family + locale,
 *  or null when none exists. Consumers use this to apply the OAP
 *  overlay on top of the source + disk overlay at render time. */
export function findOverlayRow(
  status: SyncStatus,
  kind: TemplateKind,
  key: string,
  locale: string,
): TemplateRow | null {
  for (const r of status.rows) {
    if (r.locale === locale && r.kind === kind && r.key === key && !!r.remote && !r.remote.disabled) {
      return r;
    }
  }
  return null;
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
