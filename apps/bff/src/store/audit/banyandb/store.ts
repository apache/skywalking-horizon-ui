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
 * The audit log on BanyanDB.
 *
 * The feature is the same one the page has always offered — record a sign-in,
 * list them newest-first with three filters, count them per hour, count token
 * use per credential per hour. How it is reached here follows from what
 * BanyanDB is: a person is a series, so their sign-ins live together; an hour
 * is a timestamp, so a window is a time range; retention is the group's TTL,
 * so nothing sweeps.
 */

import {
  BanyanDBClient,
  type SchemaKey,
  and,
  eq,
  in_,
  isSucceeded,
  type BanyanDBOptions,
  type SchemaChange,
} from '../../../client/banyandb/index.js';
import { logger } from '../../../logger.js';
import { overFetchSize, pageOffset, takeOverFetched } from '../../../logic/paging/read-page.js';
import { hourBucketOf } from '../counters.js';
import { windowBuckets, type TokenUsage, type TokenUsageEntry, type TokenUsageRange, type TokenUsageStore } from '../token-usage.js';
import {
  AuditStoreError,
  type AuditEvent,
  type AuditFilter,
  type AuditPageResult,
  type AuditStat,
  type AuditStatResult,
  type AuditStatWindow,
  type AuditStore,
  type StoreStamp,
  type StoreError,
} from '../types.js';
import { fail } from './errors.js';
import { hourStart, toEntry, toStatRow, toStreamRow, toUsageEntry, toUsageRow } from './rows.js';
import {
  kindIndex,
  kindIndexBinding,
  logStream,
  measureGroup,
  statMeasure,
  streamGroup,
  tokenUsageMeasure,
  type AuditSchemaNames,
} from './schema.js';

/**
 * Refuse an aggregate read that came back at its ceiling.
 *
 * These two reads are SUMMED, so a missing row does not look missing — it
 * looks like a smaller number, which is the one failure an operator cannot
 * see. Better to say the window cannot be read than to draw a total that is
 * quietly low.
 *
 * Deliberately NOT paged with `offset`, though the client offers it. Every
 * node's row for an hour carries the SAME timestamp (`hourStart`), BanyanDB
 * orders on timestamp with no secondary key, and a page boundary inside a tie
 * group can repeat or drop a row. On a list that costs one misplaced row; in a
 * sum it silently changes the answer, so the whole window is read at once and
 * the size is bounded instead.
 *
 * The ceilings are far above any real deployment — an hour would need 512
 * Horizon processes, or 4 096 credential-and-process pairs — so reaching one
 * means something is wrong rather than that someone is busy.
 */
function refuseIfTruncated(got: number, ceiling: number, what: string, hours: number): void {
  if (got <= ceiling) return;
  logger.error(
    { ceiling, hours, what },
    'audit: the window holds more rows than an aggregate read may return — refusing rather than reporting a low total',
  );
  throw new AuditStoreError('too_large');
}

export interface BanyanDBAuditConfig extends AuditSchemaNames {
  connection: BanyanDBOptions;
}

/** How long the barrier waits for every data node to see a new schema before
 *  the store gives up and refuses to start. */
const BARRIER_MS = 30_000;

export class BanyanDBAuditStore implements AuditStore, TokenUsageStore {
  private client: BanyanDBClient | undefined;
  /** In flight, so two callers entering together build one client rather than
   *  two — the second would overwrite the first and orphan its channel. */
  private opening: Promise<void> | null = null;
  /** Reopening after a close is legitimate — the service retries `open()` on
   *  its tick — so this only guards the window inside one `open()` call. */
  private closed = false;
  private seq = 0;

  constructor(private readonly cfg: BanyanDBAuditConfig) {}

  /** Built in `open`, not in the constructor: reading a CA file is filesystem
   *  work, and audit setup promises never to stop the console booting — an
   *  unreadable authority disables this feature rather than killing the
   *  process. */
  private get bdb(): BanyanDBClient {
    if (!this.client) throw new AuditStoreError('unreachable');
    return this.client;
  }

  async open(): Promise<void> {
    // Idempotent, as the contract promises. The service retries `open()` on
    // every tick while the store is unavailable, so building a client here
    // unconditionally allocated a gRPC channel — and its reconnect backoff
    // timers — per tick, of which only the newest was reachable by `close()`.
    // Keeping the one client is also the better behaviour: a gRPC channel
    // reconnects itself, which is the whole reason to hold one.
    // `opening` FIRST. The client is published before the schema is applied,
    // because `migrate` reads it — so a caller arriving in that window would
    // see a client and return to write into a schema that is not there yet.
    if (this.opening) return this.opening;
    if (this.client) return;
    this.opening = this.runOpen().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async runOpen(): Promise<void> {
    this.closed = false;
    const client = new BanyanDBClient(this.cfg.connection);
    try {
      await client.connect();
      // Published before the schema step because `migrate`/`verify` read it
      // through `this.bdb` — and taken back down again if either throws, so a
      // failed open leaves nothing half-open behind it.
      this.client = client;
      await this.migrate();
      if (this.closed) {
        this.client = undefined;
        client.close();
      }
    } catch (err) {
      this.client = undefined;
      client.close();
      // A schema fault is already the right answer; re-classifying it would
      // report a reachable server as unreachable.
      if (err instanceof AuditStoreError) throw err;
      fail(err);
    }
  }

  /**
   * Groups first, then their resources, then the index rule, then the binding
   * that makes it live — each needs the one before it to exist.
   *
   * The barrier is what makes the first write safe: the registry accepts a
   * schema at the liaison before every data node has seen it, and a node that
   * has not rejects the row.
   */
  private async migrate(): Promise<void> {
    const n: AuditSchemaNames = this.cfg;
    const sg = streamGroup(n).name;
    const mg = measureGroup(n).name;

    // Each resource's OWN revision. The barrier compares per key, so handing
    // every key the newest revision seen anywhere asks a stream to reach a
    // revision only the binding ever had — which it cannot, and the wait runs
    // to its deadline.
    const waits: { key: SchemaKey; minRevision: string }[] = [];
    const applied = async (key: SchemaKey, change: Promise<SchemaChange>): Promise<SchemaChange> => {
      const c = await change;
      if (c.action !== 'unchanged') waits.push({ key, minRevision: c.modRevision });
      return c;
    };

    await applied({ kind: 'group', group: sg, name: sg }, this.bdb.schema.group(streamGroup(n)));
    await applied({ kind: 'group', group: mg, name: mg }, this.bdb.schema.group(measureGroup(n)));
    await applied({ kind: 'stream', group: sg, name: 'log' }, this.bdb.schema.stream(logStream(n)));
    await applied({ kind: 'measure', group: mg, name: 'sign_in' }, this.bdb.schema.measure(statMeasure(n)));
    await applied(
      { kind: 'measure', group: mg, name: 'token_usage' },
      this.bdb.schema.measure(tokenUsageMeasure(n)),
    );
    await applied(
      { kind: 'index_rule', group: sg, name: kindIndex(n).name },
      this.bdb.schema.indexRule(kindIndex(n)),
    );
    await applied(
      { kind: 'index_rule_binding', group: sg, name: kindIndexBinding(n).name },
      this.bdb.schema.indexRuleBinding(kindIndexBinding(n)),
    );

    if (waits.length === 0) return;
    const barrier = await this.bdb.awaitSchemaApplied(waits, BARRIER_MS);
    // An older server has no barrier to offer; that is a fact about it, not a
    // fault. A timeout IS one: writing into a schema some node has not seen
    // loses rows that reported success.
    if (!barrier.applied && !barrier.unimplemented) throw new AuditStoreError('schema_error');
  }

  async close(): Promise<void> {
    // Set before anything else: `runOpen` checks it after its own awaits and
    // disposes rather than publishing, so a close landing mid-open cannot
    // leave a live channel that nothing holds a reference to.
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    client?.close();
  }

  /**
   * Reachable AND writable-into.
   *
   * The same check-and-fix `open()` runs, because the recovery path this sits
   * on is clearing a WRITE fault and has to vouch for what a write needs: the
   * whole schema, present and shaped as this build writes it. Listing groups
   * would only prove a liaison answers. Running the migration rather than a
   * read-only comparison also means a schema someone has since dropped or
   * altered is REPAIRED here, instead of being reported every tick forever —
   * and it costs nothing when nothing has changed, since an unchanged
   * resource is a read and no barrier wait.
   */
  async probe(): Promise<{ available: boolean; writable: boolean; error?: StoreError }> {
    try {
      await this.migrate();
      // Reachable and correctly shaped — but NOT `writable`. There is no
      // rollback here, so proving a write would land means recording a
      // sign-in that never happened. A write fault therefore stands until one
      // of this store's OWN writes succeeds.
      return { available: true, writable: false };
    } catch (err) {
      if (err instanceof AuditStoreError) return { available: false, writable: false, error: err.code };
      try {
        fail(err);
      } catch (e) {
        return { available: false, writable: false, error: (e as AuditStoreError).code };
      }
    }
  }

  async writeEvents(rows: ReadonlyArray<AuditEvent & StoreStamp>): Promise<void> {
    if (rows.length === 0) return;
    try {
      const outcomes = await this.bdb.insertStream(
        logStream(this.cfg),
        rows.map((r) => toStreamRow(r, this.seq++)),
      );
      // Every row is accounted for. A batch where some landed and some did not
      // is a partial write, and reporting it as success would leave the caller
      // believing sign-ins were recorded that were not.
      if (!outcomes.every((o) => isSucceeded(o.status))) throw new AuditStoreError('unreachable');
    } catch (err) {
      if (err instanceof AuditStoreError) throw err;
      fail(err);
    }
  }

  async writeStat(stat: AuditStat): Promise<void> {
    try {
      const [outcome] = await this.bdb.writeMeasure(statMeasure(this.cfg), [toStatRow(stat)]);
      if (!outcome || !isSucceeded(outcome.status)) throw new AuditStoreError('unreachable');
    } catch (err) {
      if (err instanceof AuditStoreError) throw err;
      fail(err);
    }
  }

  async writeUsage(rows: ReadonlyArray<TokenUsage & StoreStamp>): Promise<void> {
    if (rows.length === 0) return;
    try {
      const outcomes = await this.bdb.writeMeasure(tokenUsageMeasure(this.cfg), rows.map(toUsageRow));
      if (!outcomes.every((o) => isSucceeded(o.status))) throw new AuditStoreError('unreachable');
    } catch (err) {
      if (err instanceof AuditStoreError) throw err;
      fail(err);
    }
  }

  /**
   * Newest first, `pageSize * (pageNum - 1)` rows in.
   *
   * BanyanDB applies the skip after ordering and after merging every shard, so
   * the page begins where the same page would begin anywhere else. It orders
   * on timestamp alone, though, with no secondary key — so a boundary landing
   * inside one millisecond can order that tie group either way, which is the
   * same property every OAP list on BanyanDB has.
   */
  async query(filter: AuditFilter): Promise<AuditPageResult> {
    const size = Math.max(1, filter.pageSize);
    // Both edges are inclusive on this wire; the filter's `to` is exclusive.
    const endMs = (filter.to ?? Date.now() + 1) - 1;
    try {
      const elements = await this.bdb.queryStream({
        group: streamGroup(this.cfg).name,
        name: 'log',
        timeRange: { beginMs: filter.from ?? 0, endMs },
        projection: [
          { family: 'searchable', tags: ['username', 'kind', 'outcome'] },
          {
            family: 'data',
            tags: ['provider', 'protocol', 'reason', 'mail', 'roles', 'client_ip', 'horizon_ip', 'horizon_node'],
          },
        ],
        criteria: and(
          filter.username ? eq('username', 'TAG_TYPE_STRING', filter.username) : undefined,
          filter.kind?.length ? in_('kind', 'TAG_TYPE_STRING', filter.kind) : undefined,
        ),
        limit: overFetchSize(size),
        // BanyanDB skips AFTER ordering and after merging every shard, so this
        // is the same row the same page would start at anywhere else. Sending
        // no `orderBy` would page an ASCENDING list — the wire's default when
        // none is given is oldest-first.
        offset: pageOffset(filter.pageNum, size),
        orderBy: { sort: 'SORT_DESC' },
      });

      const { rows, hasNext } = takeOverFetched(elements.map(toEntry), size);
      return { rows, pageNum: filter.pageNum, pageSize: size, hasNext };
    } catch (err) {
      fail(err);
    }
  }

  async queryStat(window: AuditStatWindow): Promise<AuditStatResult> {
    const now = Date.now();
    const buckets = windowBuckets({ from: now - (window - 1) * 3_600_000, to: now });
    // One row per hour per node, so the count is the window times however
    // many Horizon processes wrote in it.
    const statCeiling = Math.max(512, buckets.length * 512);
    try {
      const points = await this.bdb.queryMeasure({
        group: measureGroup(this.cfg).name,
        name: 'sign_in',
        timeRange: { beginMs: hourStart(buckets[buckets.length - 1] ?? hourBucketOf(now)), endMs: now },
        projection: [{ family: 'searchable', tags: ['horizon_node', 'hour_bucket'] }],
        fieldProjection: ['login_local', 'login_ldap', 'login_oidc', 'login_oauth', 'rejected', 'over_budget'],
        // One past the ceiling: the extra row is how a full read is told from
        // a read that merely reached the bound exactly.
        limit: statCeiling + 1,
      });
      refuseIfTruncated(points.length, statCeiling, 'sign-in statistics', buckets.length);

      // Each process reports its own share, so an hour is their sum.
      const byBucket = new Map<number, AuditStatResult['columns'][number]>();
      const nodes = new Set<string>();
      let overBudget = 0;
      for (const p of points) {
        const bucket = Number(p.tags.hour_bucket);
        if (!buckets.includes(bucket)) continue;
        // The host half only: `horizon_node` is host:boot-id, so counting the
        // whole value counts process INCARNATIONS — 40 after a crash loop of
        // two replicas — where the contract asks for distinct hosts.
        nodes.add(String(p.tags.horizon_node ?? '').split(':')[0] ?? '');
        const col = byBucket.get(bucket) ?? {
          hourBucket: bucket,
          login: { local: 0, ldap: 0, oidc: 0, oauth: 0 },
          rejected: 0,
        };
        col.login.local += Number(p.fields.login_local ?? 0);
        col.login.ldap += Number(p.fields.login_ldap ?? 0);
        col.login.oidc += Number(p.fields.login_oidc ?? 0);
        col.login.oauth += Number(p.fields.login_oauth ?? 0);
        col.rejected += Number(p.fields.rejected ?? 0);
        overBudget += Number(p.fields.over_budget ?? 0);
        byBucket.set(bucket, col);
      }

      // A quiet hour is a zero, not a gap: a missing column reads as missing
      // data, which is a different claim.
      const columns = [...buckets]
        .reverse()
        .map((b) => byBucket.get(b) ?? { hourBucket: b, login: { local: 0, ldap: 0, oidc: 0, oauth: 0 }, rejected: 0 });
      return { columns, overBudget, horizonNodes: nodes.size };
    } catch (err) {
      fail(err);
    }
  }

  async readWindow(range: TokenUsageRange): Promise<TokenUsageEntry[]> {
    const buckets = windowBuckets(range);
    const oldest = buckets[buckets.length - 1];
    // Rows are per credential per process per hour, so the count is the
    // window times both.
    const usageCeiling = Math.max(4_096, buckets.length * 4_096);
    try {
      const points = await this.bdb.queryMeasure({
        group: measureGroup(this.cfg).name,
        name: 'token_usage',
        // `-1`: both edges are inclusive here, `range.to` is exclusive.
        timeRange: { beginMs: oldest === undefined ? range.from : hourStart(oldest), endMs: range.to - 1 },
        projection: [{ family: 'searchable', tags: ['token_id', 'horizon_node', 'hour_bucket', 'username'] }],
        fieldProjection: ['count'],
        limit: usageCeiling + 1,
      });
      // Windowed BEFORE the ceiling is judged: both edges are inclusive on
      // this wire while `range.to` is exclusive, so a row landing exactly on
      // the boundary is fetched and then dropped — and counting it toward the
      // ceiling would refuse a window that fits.
      const entries = points.map(toUsageEntry).filter((e) => buckets.includes(e.hourBucket));
      refuseIfTruncated(entries.length, usageCeiling, 'token usage', buckets.length);
      return entries;
    } catch (err) {
      fail(err);
    }
  }

  /** Retention is the group's TTL, declared when the schema is applied. There
   *  is nothing to delete on a timer. */
  async sweep(): Promise<number> {
    return 0;
  }
}
