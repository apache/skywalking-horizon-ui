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
  isOverlayName,
  parseEnvelope,
  serializeEnvelope,
  type TemplateKind,
} from './names.js';
import { iterateBundledOverlays } from './aggregator.js';
import { templateIdentityIssue } from './identity.js';

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
  /** What the renderer should use, and the field every render path decides
   *  content on: `'remote'` means this row's remote configuration is content
   *  any reader may serve. `null` for `disabled` and for {@link unreadable}
   *  — a row can carry a `remote` an admin page still needs (to diff it, to
   *  push over it) while being content no page may render. */
  effective: 'remote' | 'bundled' | null;
  /** Why this row is not readable AS what it is stored as — the identity
   *  rule's single reason (see {@link UnreadableRow}). Set only on enabled
   *  source rows; forces `effective: null`. */
  unreadable?: string;
  /** Remote-side detail. `null` when remote-absent. */
  remote: { id: string; configuration: string; disabled: boolean } | null;
  /** Bundled-side serialized envelope. `null` when bundled-absent (`remote-only`). */
  bundled: { configuration: string } | null;
}

export interface ConflictRow {
  /** Envelope name (e.g. `horizon.layer.ACTIVEMQ`) seen on >1 enabled
   *  OAP record. The BFF renders one of them and surfaces this list so
   *  the operator can disable the extras. */
  name: string;
  kind: TemplateKind;
  key: string;
  /** UUIDs of every enabled OAP row that shares this name, sorted ASC.
   *  Horizon renders the lowest of these and touches none of them.
   *  Sorted, not ranked: the survivor is NOT always the first element. */
  enabledIds: string[];
  /** Every enabled row carries byte-identical configuration — a duplicated
   *  name, but an unambiguous definition. See {@link ambiguousConflicts}. */
  identical: boolean;
}

/** An enabled OAP row no reader can resolve: its name is not the one Horizon
 *  reads a template of that kind under, or its content declares a different
 *  identity than the row it sits in. Reported, never touched — the same stance
 *  as {@link ConflictRow} — and never RENDERED: the matching {@link TemplateRow}
 *  carries `effective: null`, so every read path drops it exactly as it drops a
 *  disabled row. */
export interface UnreadableRow {
  /** OAP record id — what an operator needs to retire it on OAP. */
  id: string;
  name: string;
  kind: TemplateKind;
  /** Which of the two is wrong, and the readable form — self-contained. */
  reason: string;
}

export interface SyncStatus {
  /** Template source mode. `live` = read/write via OAP's ui_template store
   *  (default). `readonly` = the store is never consulted; `rows` are the local
   *  disk bundle loaded into the same in-memory shape and presented as the
   *  effective content, and the config surface is read-only. */
  mode: 'live' | 'readonly';
  /** When true, OAP admin was unreachable at the time this status was
   *  computed. `rows` will be a bundled-only view (every bundled row marked
   *  `bundled-fallback`, no remote info). Always false in `readonly` mode —
   *  the store is deliberately not used, not unreachable. */
  unreachable: boolean;
  /** Epoch ms of the most-recent successful OAP probe. `null` when we
   *  have never reached OAP since process start. */
  lastSuccessfulSyncAt: number | null;
  /** When this status snapshot was generated. */
  generatedAt: number;
  rows: TemplateRow[];
  /** Per-name multi-enabled conflicts: duplicates the boot reconcile
   *  hasn't collapsed — seen on a read between boots, or left behind by
   *  a disable OAP refused. Empty list = no conflicts. The admin UI
   *  renders a banner per entry. */
  conflicts: ConflictRow[];
  /** Enabled rows nobody can read (see {@link UnreadableRow}). The publish
   *  boundary refuses to create these, so a non-empty list is either a row
   *  written before that check existed or one written by something other than
   *  Horizon; either way nothing renders it, which is precisely why it has to
   *  be reported rather than left to be noticed. */
  unreadable: UnreadableRow[];
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

/** Boot-time template mode (`config.templates.mode`). In `readonly` the
 *  orchestrator never touches the ui_template client — `runOnce` short-circuits
 *  to the disk bundle. Set once at boot (and on config reload) by the server. */
let readOnlyMode = false;
export function setTemplateReadOnly(on: boolean): void {
  readOnlyMode = on;
  // A mode flip must not serve a stale cross-mode status: drop the cache AND
  // orphan any in-flight probe (it still resolves its awaiters, but won't
  // backfill the cache with a result computed under the old mode).
  cache = null;
  inFlight = null;
}
export function isTemplateReadOnly(): boolean {
  return readOnlyMode;
}

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

  // readonly mode: the disk bundle IS the source. Never call the ui_template
  // client (no list, no seed); present every bundled source + translation
  // overlay as the effective content so all render consumers resolve them
  // exactly as they would a live remote row.
  if (readOnlyMode) {
    lastSuccessfulSyncAt = now;
    // Source overlays from the canonical disk iterator — the on-demand render
    // callers (bundle / menu / overlay / effective) don't pass `bundledOverlays`
    // (only the boot seed does, and that's skipped in readonly), so without this
    // every non-English locale would silently render in English.
    const overlays = deps.bundledOverlays ? [...deps.bundledOverlays()] : [...iterateBundledOverlays()];
    return {
      mode: 'readonly',
      unreachable: false,
      lastSuccessfulSyncAt,
      generatedAt: now,
      rows: readonlyRows(bundledRows, overlays),
      conflicts: [],
      unreadable: [],
    };
  }

  let oapRows;
  try {
    oapRows = await deps.client.list();
  } catch (err) {
    deps.logger.warn(
      { err: errMsg(err), action: opts.write ? 'boot-seed' : 'runtime-sync' },
      'OAP UI-template list failed — rendering bundled, admin read-only',
    );
    return {
      mode: 'live',
      unreachable: true,
      lastSuccessfulSyncAt,
      generatedAt: now,
      rows: bundledOnlyRows(bundledRows, 'bundled-fallback'),
      conflicts: [],
      unreadable: [],
    };
  }

  lastSuccessfulSyncAt = (deps.now ?? Date.now)();
  let parsedRemote = parseRemoteRows(oapRows, deps.logger);

  if (opts.write) {
    const seedCount = await seedMissing(deps, bundledRows, parsedRemote.byName);
    const overlaySeedCount = await seedMissingOverlays(deps, parsedRemote.byName);
    // Duplicates are REPORTED at boot, never resolved here. Retiring a row is
    // irreversible for that copy's CONTENT (OAP has no delete, only disable;
    // the admin Reactivate control re-enables a name from the bundled default,
    // it does not bring a disabled copy's content back), and the rule reads an
    // operator edit from a pristine seed — so two instances on different
    // Horizon versions, mid rolling-upgrade, can each judge the other's
    // survivor to be the loser and between them disable every row for a name.
    // A restart must never be able to do that unattended. The conflict is
    // surfaced on the sync status instead, and an admin resolves it
    // deliberately from the Dashboard-templates banner.
    if (seedCount > 0 || overlaySeedCount > 0) {
      try {
        const refreshed = await deps.client.list();
        parsedRemote = parseRemoteRows(refreshed, deps.logger);
        deps.logger.info(
          { seedCount, overlaySeedCount },
          'OAP UI-template boot seed complete',
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
    mode: 'live',
    unreachable: false,
    lastSuccessfulSyncAt,
    generatedAt: now,
    rows,
    conflicts: parsedRemote.conflicts,
    unreadable: parsedRemote.unreadable,
  };
}

/** readonly-mode rows: every bundled source template + translation overlay,
 *  presented with the disk content as the effective (`remote`) configuration so
 *  every render consumer resolves them uniformly (the ui_template store is never
 *  consulted in this mode). `status: 'synced'` because the rendered config is,
 *  by construction, exactly the bundled source; the synthetic `bundled:` id is
 *  never used for a write (writes are denied in readonly). */
function readonlyRows(bundled: Map<string, BundledRow>, overlays: BundledOverlay[]): TemplateRow[] {
  const out: TemplateRow[] = [];
  for (const b of bundled.values()) {
    out.push({
      name: b.name,
      kind: b.kind,
      key: b.key,
      status: 'synced',
      effective: 'remote',
      remote: { id: `bundled:${b.name}`, configuration: b.configuration, disabled: false },
      bundled: { configuration: b.configuration },
    });
  }
  for (const ov of overlays) {
    const env = buildOverlayEnvelope(ov.kind, ov.key, ov.locale, ov.content);
    const configuration = serializeEnvelope(env);
    out.push({
      name: env.name,
      kind: ov.kind,
      key: ov.key,
      locale: ov.locale,
      status: 'synced',
      effective: 'remote',
      remote: { id: `bundled:${env.name}`, configuration, disabled: false },
      bundled: { configuration },
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Thrown when a write to OAP succeeded but the resulting row state
 *  didn't become visible to `list()` within the polling window. Routes
 *  catch this and return 504. */
export class WriteNotVisibleError extends Error {
  readonly kind: 'create' | 'update' | 'disable';
  readonly id: string;
  readonly timeoutMs: number;
  constructor(kind: 'create' | 'update' | 'disable', id: string, timeoutMs: number) {
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
  if (hit === null) throw new WriteNotVisibleError('disable', id, WRITE_VISIBILITY_TIMEOUT_MS);
}

/**
 * Which row RENDERS when a name sits on several enabled OAP rows: the
 * lowest id, always. Display only — Horizon never resolves a duplicate.
 * Deliberately content-blind: any rule that inspected the rows would have
 * to rank one operator's dashboard above another's, and that is not a
 * judgement a renderer (or a restart) gets to make. The conflict is
 * reported instead, and cleaning it up is an OAP-side decision.
 */
function pickDuplicateWinner<T extends { id: string; disabled: boolean }>(rows: readonly T[]): T {
  const byId = rows.slice().sort((a, b) => a.id.localeCompare(b.id));
  return byId.find((r) => !r.disabled) ?? byId[0]!;
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
  /** Identity-rule reason, when this row is not readable as what it is stored
   *  as. Carried per row (not per name): duplicates are resolved content-blind,
   *  so one twin can be readable while the other is not. */
  unreadable?: string;
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
  /** Names where >1 ENABLED row exists. The BFF renders the
   *  `pickDuplicateWinner` row; the admin UI surfaces the rest. */
  conflicts: ConflictRow[];
  unreadable: UnreadableRow[];
}

function parseRemoteRows(
  rows: Array<{ id: string; configuration: string; disabled: boolean }>,
  logger: Logger,
): ParsedRemote {
  /* OAP doesn't enforce uniqueness on envelope name (only on its own
   * row id), so duplicates happen — typically a disabled tombstone +
   * a current enabled record, but two enabled rows also occur on a
   * store written by an OAP release that minted its own row ids.
   *
   * `pickDuplicateWinner` resolves which row is live; every name with
   * more than one ENABLED row is also surfaced as a `conflict` so the
   * admin UI can prompt a reconcile. */
  const groups = new Map<string, Array<RemoteRow>>();
  const unreadable: UnreadableRow[] = [];
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
    const key = env.locale === undefined
      ? env.name.split('.').slice(2).join('.')
      : env.name.split('.').slice(2, -2).join('.');
    // A disabled row is already served to nobody, and an overlay carries its
    // parent's identity rather than one of its own — only a LIVE source row
    // that no reader can resolve is both reportable and renderable-by-mistake.
    const issue =
      !r.disabled && env.locale === undefined
        ? templateIdentityIssue(env.kind, key, env.content)
        : null;
    const row: RemoteRow = {
      name: env.name,
      kind: env.kind,
      key,
      locale: env.locale,
      id: r.id,
      configuration: r.configuration,
      disabled: r.disabled,
      ...(issue ? { unreadable: issue.message } : {}),
    };
    const list = groups.get(env.name) ?? [];
    list.push(row);
    groups.set(env.name, list);
    if (issue) {
      unreadable.push({ id: r.id, name: env.name, kind: env.kind, reason: issue.message });
    }
  }
  const out = new Map<string, RemoteRow>();
  const conflicts: ConflictRow[] = [];
  for (const [name, list] of groups) {
    const winner = pickDuplicateWinner(list);
    out.set(name, winner);
    const enabled = list.filter((r) => !r.disabled).sort((a, b) => a.id.localeCompare(b.id));
    if (enabled.length > 1) {
      conflicts.push({
        name,
        kind: winner.kind,
        key: winner.key,
        enabledIds: enabled.map((r) => r.id),
        identical: enabled.every((r) => r.configuration === enabled[0]!.configuration),
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
      { conflicts: conflicts.map((c) => ({ name: c.name, ids: c.enabledIds, identical: c.identical })) },
      'OAP UI-template name conflicts (>1 enabled row) — Horizon renders the lowest-id row and changes NOTHING on its own. ' +
        'Retiring a row does not bring its content back (OAP soft-disables; the admin Reactivate control restores the bundled default, not the disabled copy), so clean this up on OAP ' +
        'once you have confirmed which copy you want to keep.',
    );
  }
  if (unreadable.length > 0) {
    logger.warn(
      { rows: unreadable },
      'OAP UI-template rows Horizon cannot read as the template they are stored as — the name is not one this kind ' +
        'is read under, or the content names a different template than the record it sits in. They render for nobody: ' +
        'no page is served from them, whichever of the two is wrong. Republish each one so its stored name and its ' +
        'content agree, then retire the record left behind if that moved it to a different name; Horizon changes ' +
        'nothing on its own.',
    );
  }
  return { byName: out, conflicts, unreadable };
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
      // An identity-invalid row keeps its bundled-vs-remote status — that is
      // what the admin diffs and pushes over to repair it — but serves no one.
      effective: r.unreadable ? null : 'remote',
      ...(r.unreadable ? { unreadable: r.unreadable } : {}),
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
      effective: r.disabled || r.unreadable ? null : 'remote',
      ...(r.unreadable ? { unreadable: r.unreadable } : {}),
      remote: { id: r.id, configuration: r.configuration, disabled: r.disabled },
      bundled: null,
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Conflicts of `kind` whose enabled copies actually DIFFER — the subset the
 * navigation surfaces (sidebar menu, config bundle) hide on, because there
 * the template's definition is genuinely ambiguous and no renderer gets to
 * pick a winner for the operator.
 *
 * Two exclusions, both deliberate:
 *   - byte-identical copies: the name is duplicated, the definition is not.
 *     Hiding those would cost the operator a working dashboard to punish a
 *     bookkeeping problem on OAP. They stay reported (`status.conflicts`).
 *   - per-locale overlay rows: they carry their parent's `kind` + `key`, but
 *     a duplicated translation never makes the parent's definition ambiguous.
 *
 * Reads `status.conflicts`, which is empty whenever the store was unreachable
 * or unread — so hiding always follows a POSITIVE signal, never an absent one.
 */
export function ambiguousConflicts(status: SyncStatus, kind: TemplateKind): ConflictRow[] {
  return status.conflicts.filter(
    (c) => c.kind === kind && !c.identical && !isOverlayName(c.name),
  );
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
