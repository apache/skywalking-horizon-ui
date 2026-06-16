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
 * Wire types for the runtime-rule REST surface and the cluster-status
 * query. Mirrors `reference_runtime_rule_api.md` in Claude memory; the
 * authoritative source is the upstream
 * `RuntimeRuleRestHandler.java` + `RuntimeRuleService.java` on
 * `feature/runtime-rule-hot-update` (squashed tip in
 * `~/github/skywalking`).
 *
 * v1 binds to MAL + LAL only. OAL is permanently excluded from
 * hot-update.
 */

// ── Catalogs ───────────────────────────────────────────────────────

export const CATALOGS = ['otel-rules', 'log-mal-rules', 'telegraf-rules', 'lal'] as const;
export type Catalog = (typeof CATALOGS)[number];

export function isCatalog(value: unknown): value is Catalog {
  return typeof value === 'string' && (CATALOGS as readonly string[]).includes(value);
}

// ── Status / loader enums ──────────────────────────────────────────

export type RuleStatus = 'ACTIVE' | 'INACTIVE' | 'BUNDLED' | 'n/a';
export type LocalState = 'RUNNING' | 'SUSPENDED' | 'NOT_LOADED';
export type SuspendOrigin = 'NONE' | 'LOCAL_APPLY' | 'PEER_BROADCAST';
export type LoaderGc = 'LIVE' | 'PENDING' | 'COLLECTED';
export type LoaderKind = 'RUNTIME' | 'BUNDLED' | 'NONE';

// ── /runtime/rule/list ─────────────────────────────────────────────

export interface LoaderStats {
  active: number;
  pending: number;
}

interface ListRowBase {
  catalog: Catalog;
  name: string;
  localState: LocalState;
  loaderGc: LoaderGc;
  loaderKind: LoaderKind;
  /** Format: `<kind>:<catalog>/<rule>@<MMdd-HHmmss>`, e.g.
   *  `runtime:otel-rules/vm@0429-101900`. Empty string when no per-file
   *  loader exists (typical for bundled-only rules served from the
   *  default loader). */
  loaderName: string;
  /** SHA-256 hex of the currently-served content. */
  contentHash: string;
  /** True iff a static twin exists on disk for this `(catalog, name)`. */
  bundled: boolean;
  /** SHA-256 hex of the static twin; absent when `bundled === false`. */
  bundledContentHash?: string;
}

/** Operator-pushed runtime row. */
export interface OperatorRow extends ListRowBase {
  status: 'ACTIVE' | 'INACTIVE';
  suspendOrigin: SuspendOrigin;
  updateTime: number;
  lastApplyError: string;
  pendingUnregister: false;
}

/** Bundled-only row — shipped on disk, no operator override. */
export interface BundledRow extends ListRowBase {
  status: 'BUNDLED';
  pendingUnregister: false;
}

/** Orphan row — DAO row was deleted, dslManager hasn't swept yet.
 *  Transient — gone within one tick. */
export interface OrphanRow extends ListRowBase {
  status: 'n/a';
  pendingUnregister: true;
}

export type ListRow = OperatorRow | BundledRow | OrphanRow;

export interface ListEnvelope {
  generatedAt: number;
  loaderStats: LoaderStats;
  rules: ListRow[];
}

// ── /runtime/rule/bundled ──────────────────────────────────────────

export interface BundledEntry {
  name: string;
  /** mal | lal — derived from catalog when relevant. */
  kind: string;
  contentHash: string;
  /** Present iff `withContent=true` was requested (the default). */
  content?: string;
  /** True if a runtime override row exists for this name. */
  overridden: boolean;
}

// ── /runtime/rule (single-rule fetch) ──────────────────────────────

export type RuleSource = 'runtime' | 'bundled';

/** The JSON envelope returned when the client passes
 *  `Accept: application/json`. Default mode returns raw YAML; the
 *  client wrapper normalises both into a {@link RuleResponse}. */
export interface RuleJsonEnvelope {
  catalog: string;
  name: string;
  /** Note: legacy `STATIC` may appear on older OAP builds; new ones
   *  return `BUNDLED` consistently with `/list`. */
  status: RuleStatus | 'STATIC';
  source: 'runtime' | 'static';
  contentHash: string;
  updateTime: number;
  content: string;
}

export interface RuleResponse {
  status: RuleStatus | 'STATIC';
  source: 'runtime' | 'static';
  contentHash: string;
  updateTime: number;
  /** Echo of `ETag` response header, with surrounding quotes. */
  etag: string;
  /** Raw YAML body. */
  content: string;
}

/** Returned by `RuntimeRuleClient.get()` when the server replies `304
 *  Not Modified` to a conditional request — the client did not waste
 *  bandwidth on an unchanged body. */
export interface NotModified {
  notModified: true;
  etag: string;
  contentHash: string;
  status: RuleStatus | 'STATIC';
}

// ── /runtime/rule/addOrUpdate ──────────────────────────────────────

/**
 * Open-ended for forward compatibility: OAP may add new applyStatus
 * codes. The values here are the ones documented today.
 */
export type ApplyStatus =
  | 'no_change'
  | 'filter_only_applied'
  | 'filter_only_persisted'
  | 'structural_applied'
  | 'inactivated'
  | 'static_tombstoned'
  | 'already_inactive'
  | 'not_found'
  | 'deleted'
  | 'reverted_to_bundled'
  | 'persisted_apply_pending'
  | 'compile_failed'
  | 'empty_body'
  | 'invalid_catalog'
  | 'invalid_name'
  | 'invalid_delete_mode'
  | 'no_bundled_twin'
  | 'storage_change_requires_explicit_approval'
  | 'requires_inactivate_first'
  | 'requires_revert_to_bundled'
  | 'ddl_verify_failed'
  | 'apply_failed'
  | 'persist_failed';

export interface ApplyResult {
  /** One of {@link ApplyStatus}; typed as `string` so a server-side
   *  addition doesn't break the client deserialiser. */
  applyStatus: ApplyStatus | (string & {});
  catalog: string;
  name: string;
  message: string;
  /** Present ONLY on `structural_applied`: the poll handle for
   *  {@link RuleStatusResponse}. The structural apply is accepted at
   *  phase `FENCING` (DDL fired, not yet durable) and the
   *  fence → persist → commit → resume tail runs in the background —
   *  poll `GET /runtime/rule/status` until a terminal phase. No other
   *  applyStatus carries an applyId (the sync paths have nothing to
   *  poll). */
  applyId?: string;
}

// ── /runtime/rule/status (structural-apply progress) ───────────────

/**
 * Lifecycle phase of a structural `/addOrUpdate`, tracked by the cluster
 * main. The HTTP apply call returns at {@link 'FENCING'}; the rest runs
 * in the background:
 *
 *   PENDING → DDL → FENCING → ROLLING_OUT → APPLIED
 *
 * with two terminal off-ramps and one unknown:
 *   - `DEGRADED` — committed + durable, but the cluster-wide schema fence
 *     didn't confirm in time (laggards listed in {@link
 *     RuleStatusResponse.fenceLaggards}) OR the local commit-tail threw.
 *     Forward-progress, NOT a revert; laggards self-converge on their
 *     next scan.
 *   - `FAILED` — a pre-commit error rolled the apply back; the cluster
 *     stays on the prior rule.
 *   - `UNKNOWN` — the applyId is no longer tracked (evicted after ~1h, or
 *     the main restarted). Re-query by `contentHash`, which degrades to
 *     the durable rule row.
 */
export type ApplyPhase =
  | 'PENDING'
  | 'DDL'
  | 'FENCING'
  | 'ROLLING_OUT'
  | 'APPLIED'
  | 'DEGRADED'
  | 'FAILED'
  | 'UNKNOWN';

/** APPLIED / DEGRADED / FAILED — a poller stops here. */
export function isTerminalPhase(phase: string): boolean {
  return phase === 'APPLIED' || phase === 'DEGRADED' || phase === 'FAILED';
}

/**
 * `GET /runtime/rule/status` response — ALWAYS HTTP 200 (`found: false`
 * when nothing matches, never 404). Three server builders emit different
 * field subsets, so everything past `found` + `phase` is conditionally
 * present:
 *   - live tracker: `applyId`, `startedAtMs`, `updatedAtMs`, `servedBy`.
 *   - durable-DAO fallback (live status gone / main unreachable): a
 *     matching ACTIVE row reports `phase: 'APPLIED'` + `derivedFrom:
 *     'durable-dao'` + `note`; NO applyId / timestamps / servedBy.
 *   - not found: `found: false`, `phase: 'UNKNOWN'`.
 * `failureReason` appears on FAILED/DEGRADED; `fenceLaggards` only on a
 * fence-non-confirm DEGRADED.
 */
export interface RuleStatusResponse {
  found: boolean;
  phase: ApplyPhase | (string & {});
  applyId?: string;
  catalog?: string;
  name?: string;
  contentHash?: string;
  failureReason?: string;
  /** Data-node ids that hadn't confirmed the new schema within the fence
   *  budget — present only on a fence-timeout DEGRADED. */
  fenceLaggards?: string[];
  startedAtMs?: number;
  updatedAtMs?: number;
  servedBy?: string;
  /** `'durable-dao'` when the status was reconstructed from the durable
   *  rule row rather than live progress (e.g. after a page reload). */
  derivedFrom?: string;
  note?: string;
}

// ── /runtime/rule/delete ───────────────────────────────────────────

export const DELETE_MODES = ['', 'revertToBundled'] as const;
export type DeleteMode = (typeof DELETE_MODES)[number];

// ── /status/cluster/nodes (port 12800) ─────────────────────────────

export interface ClusterNode {
  host: string;
  port: number;
  /** One of these two carries the boolean — Java field is `isSelf` and
   *  Gson serialisation may emit either. The wrapper normalises to the
   *  `self` field on its public type. */
  self?: boolean;
  isSelf?: boolean;
}

export interface ClusterNodesResponse {
  nodes: ClusterNode[];
}

// ── Errors ─────────────────────────────────────────────────────────

/** Thrown by the client for any HTTP response outside the expected
 *  set. Exposes the parsed body so callers can switch on
 *  `applyStatus`. */
export class RuntimeRuleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApplyResult | string,
    public readonly url: string,
  ) {
    const detail = typeof body === 'string' ? body : `${body.applyStatus}: ${body.message}`;
    super(`${status} on ${url} — ${detail}`);
    this.name = 'RuntimeRuleApiError';
  }
}
