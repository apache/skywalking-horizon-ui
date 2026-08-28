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
 * The layer header's KPI values, held per layer for one completed hour.
 *
 * WHY THIS EXISTS. The header used to be served by the same fan-out that
 * builds the service list: to rank services it read the sort metric for EVERY
 * service, then read every column for the survivors. At `bulkSize: 6` a
 * 10,000-service layer is ~1,670 requests, and the header repeats it on every
 * refresh — for numbers that describe an hour. The fan-out is not the problem
 * and does not change; running it every thirty seconds is. It now runs once
 * per layer per hour, over that hour.
 *
 * WHAT IT HOLDS. Scalars only — one value per (service, MQE) — for exactly the
 * expressions the layer template declares under `layer-header.columns`. That
 * whitelist is what bounds this to the header's KPIs instead of making it a
 * general metric cache, and membership is decided by the EXPRESSION alone, not
 * by who asked: a request may read any part of the set and nothing outside it,
 * and a scan always fills the whole set, so a request wanting part of an hour
 * cannot decide what the rest of it contains.
 *
 * One hour at a time. The hour before it is a handover, held only while the
 * new one is being read and released the moment it lands — what a bucket costs
 * is proportional to the layer's service count, so a second copy is not free.
 * No time series either: at 100k services six series of sixty buckets each is
 * tens of millions of points, where six scalars each is a few tens of MB. The
 * header's trend line is read per request instead, over the top rows only, so
 * its cost does not grow with the layer.
 *
 * WHAT IT DOES NOT CHANGE. The header's numbers aggregate the template's
 * `topN` rows, not every service — `topN: 5` means the KPI describes the five
 * busiest, and that is the product's intent rather than an approximation this
 * cache is free to widen. Holding every service's scalar makes a whole-layer
 * rollup POSSIBLE; it does not make it wanted. Rank, slice to `topN`, then
 * aggregate, exactly as before.
 *
 * WHICH HOUR. One COMPLETED bucket, taken ten minutes late: at 10:09 that is
 * still 08:00–09:00, and at 10:10 it becomes 09:00–10:00. The delay is for
 * OAP, which has not finished aggregating the hour that just ended. So the
 * numbers are between ten minutes and just over two hours old, and a caller
 * that renders them owes the operator the bucket's own label — "09:00–10:00",
 * not "an hour ago", which would jump to "two hours ago" at the roll and read
 * as a fault.
 *
 * The hour is floored on the OAP SERVER's clock, not on UTC — see
 * `targetHourStart` for why a half-hour server offset otherwise reads two
 * buckets where it meant to read one.
 *
 * WHEN IT CANNOT ANSWER. It says so, and the caller reads the operator's own
 * window instead. That is not an edge case: hour-level metrics are flushed on
 * a longer cycle than minute-level ones, so a young deployment has no hour to
 * show for a while. Returning an hour of nulls instead would be worse than
 * returning nothing, because the caller RANKS on these values — an all-null
 * hour sorts a layer alphabetically and changes the service its page opens on.
 *
 * WHEN IT LOADS. On demand. Nothing is warmed at boot and nothing is scanned
 * on a timer: a layer nobody opens is never read, and there is no moment when
 * every layer refreshes at once. The cost falls on the first request after
 * each roll, which is why `get` prefers a bucket it already has — and a layer
 * nobody has read for two hours is released rather than held for the life of
 * the process.
 */

/** Bucket boundary in ms. */
const HOUR_MS = 3_600_000;
/** How long after an hour ends before OAP is asked for it. */
const SETTLE_MS = 600_000;
/** The longest a caller waits for a bucket that does not exist yet. */
const COLD_WAIT_MS = 5_000;
/** How far into the hour in progress before it is worth reading at all.
 *
 *  Hour-level metrics are flushed on a longer cycle than minute-level ones, so
 *  the first minutes of an hour hold nothing at hour granularity however busy
 *  the deployment is. Reading it then spends the whole fan-out to be told the
 *  hour has not started yet. */
const CURRENT_HOUR_SETTLE_MS = 300_000;
/** How long a layer's buckets outlive the last request for them.
 *
 *  What is held is proportional to the layer's SERVICE COUNT, and a process
 *  serving many layers accumulates one set per layer that was ever opened —
 *  including the ones nobody has looked at since. Two hours keeps a layer an
 *  operator is working in, and releases one they have moved on from before the
 *  next hour's scan would have replaced it anyway. */
const LAYER_IDLE_MS = 2 * HOUR_MS;

/**
 * Start of the newest hour worth asking OAP for, at `now`.
 *
 * Floored on the OAP SERVER's clock, not on UTC. OAP buckets by its own local
 * calendar and the BFF names the window in that calendar, so an hour chosen on
 * a different grid does not survive being written down: under a half-hour
 * server offset (+05:30, +05:45, +09:30 …) a UTC-aligned hour formats to a
 * server-local start of one hour and an end inside the NEXT one, and the scan
 * reads two buckets where it meant to read one. Whole-hour offsets hide it,
 * which is why it is worth stating.
 */
export function targetHourStart(now: number, offsetMinutes = 0): number {
  const shift = offsetMinutes * 60_000;
  return Math.floor((now + shift - SETTLE_MS) / HOUR_MS) * HOUR_MS - HOUR_MS - shift;
}

/** Start of the hour `now` falls in, on the OAP server's clock. */
function hourFloor(now: number, offsetMinutes: number): number {
  const shift = offsetMinutes * 60_000;
  return Math.floor((now + shift) / HOUR_MS) * HOUR_MS - shift;
}

export interface KpiBucket {
  /** Start of the hour these values describe. The caller renders it. */
  hourStartMs: number;
  /** `serviceId` → MQE EXPRESSION → value. Scalars only.
   *
   *  Keyed on the expression rather than a column's name, because the name is
   *  the caller's: the layer header calls `service_cpm` "cpm" and the Overview
   *  calls it "w_0". Keyed on what was actually evaluated, both read one slot,
   *  and a column whose MQE was overridden cannot collect the value computed
   *  for the original. */
  byService: Map<string, Record<string, number | null>>;
  /** Services the scan could not READ, as opposed to read as empty. Carried
   *  with the bucket because it outlives the request that filled it: without
   *  it, an hour whose scan lost a batch ranks those services as idle for the
   *  whole hour, which is the reading a failed measurement must never produce. */
  unread: Set<string>;
  /** How much of the scan's fan-out failed. The caller reports it for as long
   *  as it serves this bucket, not only on the request that filled it. */
  batches: { total: number; failed: number };
  readAt: number;
}

export interface KpiRead {
  /**
   * Why there is or is not a bucket — the caller cannot infer it from absence.
   *
   * `warming` is the only one that means WAIT: a scan is in flight and the next
   * request will be answered from it. `empty` and `failed` both come back with
   * no bucket too, and telling a caller to wait for either leaves "still
   * reading" on screen for an answer that is never coming.
   */
  state: 'hit' | 'warming' | 'empty' | 'failed';
  /** Present only when `state` is `hit`. */
  bucket?: KpiBucket;
  /** The bucket is not the one `now` calls for — a newer one is being read.
   *  The caller says so rather than presenting it as current. */
  stale?: boolean;
  /** These values are the hour IN PROGRESS, read live and not cached.
   *
   *  Only happens while no completed hour holds anything: a SkyWalking that
   *  was installed twenty minutes ago has no previous hour to show, and an
   *  empty page would be the wrong answer when the data plainly exists. It
   *  costs a fan-out per request, which is affordable exactly because the
   *  deployments in this state are the new ones. It ends the moment a
   *  completed hour has data. */
  partial?: boolean;
}

/**
 * Reads every service's scalar for one hour.
 *
 * Supplied by the route, so this module owns the POLICY and none of the wire.
 * The scan itself keeps the existing bulk path — the same batched
 * `execExpression` fan-out the landing route already uses, unchanged. What
 * changes is how often it runs (once per layer per hour, not once per refresh)
 * and what it asks for: a Duration over the TARGET HOUR at `step: HOUR`, so
 * OAP returns one value per service instead of sixty per-minute buckets the
 * BFF would then collapse.
 */
export type ScanFn = (
  layerKey: string,
  hourStartMs: number,
) => Promise<{
  byService: Map<string, Record<string, number | null>>;
  unread: Set<string>;
  batches: { total: number; failed: number };
}>;

interface LayerState {
  /** The whitelist these buckets were read for. An admin who edits the
   *  layer's header columns changes what the hour MEANS, so everything held
   *  for the old set is dropped rather than served under the new one: values
   *  computed for a removed expression are not the new column's, and an hour
   *  that held nothing for the old metrics may hold plenty for the new ones. */
  signature: string;
  /** The hour being served. */
  current: KpiBucket | null;
  /** The hour before it, held ONLY while `current` is being read — the roll
   *  moves `current` here and the scan that replaces it clears this again. It
   *  is a handover, not a second copy: what a bucket holds is one value per
   *  service per metric, so keeping both past the handover would double what a
   *  layer costs for something nothing can ask for. */
  previous: KpiBucket | null;
  inflight: { hourStartMs: number; promise: Promise<KpiBucket | null> } | null;
  /** An hour we scanned and found EMPTY. Remembered so it is not scanned
   *  again — an hour with nothing in it does not fill in later, and rescanning
   *  it every request would be the whole fan-out for a known answer. */
  emptyHour: number | null;
  /** An hour we already re-read after an incomplete scan. Bounds the retry to
   *  ONE per hour: a backend that keeps failing must not turn the cache back
   *  into the per-request fan-out it exists to replace. */
  retriedHour: number | null;
  /** An hour-in-progress we read and found empty. Hour-level metrics are
   *  flushed on a longer period than minute-level ones, so a young deployment
   *  has neither the completed hour nor the one in progress — and re-reading
   *  the live hour on every request would spend the whole fan-out to learn
   *  that again. Remembered until the hour rolls; the caller falls back to
   *  reading the operator's own window meanwhile. */
  emptyCurrentHour: number | null;
  /** When this layer's header was last asked for. Drives eviction — see
   *  `LAYER_IDLE_MS`. */
  lastReadAt: number;
}

const layers = new Map<string, LayerState>();

/** Drop every layer's buckets. Test-only. */
export function _resetKpiCache(): void {
  layers.clear();
}

/** How many layers are currently held. Test-only — the eviction it proves has
 *  no other outward sign, and holding buckets for layers nobody reads is a leak
 *  proportional to their service counts. */
export function _kpiCacheLayers(): number {
  return layers.size;
}

function stateFor(layerKey: string, signature: string, now: number): LayerState {
  // Swept here rather than on a timer: a layer nobody reads costs nothing to
  // hold for a while, and everything this module does already happens on the
  // way through a request.
  for (const [key, held] of layers) {
    if (key !== layerKey && now - held.lastReadAt > LAYER_IDLE_MS) layers.delete(key);
  }
  let st = layers.get(layerKey);
  if (!st || st.signature !== signature) {
    // A scan already running for the old whitelist is abandoned, not awaited:
    // it resolves into a state object nothing points at any more.
    st = {
      signature,
      current: null,
      previous: null,
      inflight: null,
      emptyHour: null,
      retriedHour: null,
      emptyCurrentHour: null,
      lastReadAt: now,
    };
    layers.set(layerKey, st);
  }
  st.lastReadAt = now;
  return st;
}

/**
 * The header's values for `layerKey`, by the rule the operator sees:
 *
 *   1. the hour `now` calls for, if it is held — and if the scan that filled
 *      it lost batches, one re-read starts behind it;
 *   2. otherwise the hour before it, marked stale — a completed hour is a real
 *      reading, and only hours that held values are ever kept;
 *   3. otherwise a wait of up to five seconds for the wanted hour — the cold
 *      case, where there is nothing older to fall back to;
 *   4. otherwise, once the wanted hour is KNOWN empty, the hour in progress —
 *      read live, never cached, and not before it has had time to land;
 *   5. otherwise nothing, and the caller reads the picked window instead.
 *
 * A scan that outruns the wait is NOT cancelled. It finishes into the cache,
 * so the next request is served from it; abandoning it would make every
 * request on a large layer time out, each having thrown away the work that
 * would have answered the next one.
 */
export async function getHeaderKpis(
  layerKey: string,
  /** Identity of the whitelist being read. Changing it discards the layer's
   *  buckets — see `LayerState.signature`. */
  signature: string,
  scan: ScanFn,
  now = Date.now(),
  /** OAP server offset in minutes. Decides which hour is asked for — see
   *  `targetHourStart`. */
  offsetMinutes = 0,
): Promise<KpiRead> {
  const want = targetHourStart(now, offsetMinutes);
  const st = stateFor(layerKey, signature, now);

  // 1 — the hour we want, already held.
  if (st.current?.hourStartMs === want) {
    // Held, but read through a fan-out that lost batches: some services have no
    // value for a reason that has nothing to do with their traffic. Re-read it
    // once, behind the values we already have, so a momentary backend failure
    // costs a few seconds of an incomplete header rather than the rest of the
    // hour. The caller reports the incompleteness either way.
    if (st.current.batches.failed > 0 && st.retriedHour !== want) {
      st.retriedHour = want;
      beginScan(st, layerKey, scan, want);
    }
    return { state: 'hit', bucket: st.current, stale: false };
  }

  // The hour rolled. What was current becomes the fallback, and anything we
  // learned about an OLDER hour being empty no longer applies to this one.
  if (st.current && st.current.hourStartMs !== want) {
    st.previous = st.current;
    st.current = null;
  }
  if (st.emptyHour !== null && st.emptyHour !== want) st.emptyHour = null;

  // The scan for the wanted hour, unless we already know that hour is empty.
  // The scan for the wanted hour, unless we already know that hour is empty.
  if (st.emptyHour !== want) beginScan(st, layerKey, scan, want);

  // 2 — the hour BEFORE the one we want, if we still hold it. A completed hour
  // is a real reading; it is handed over as-is and NOT re-read.
  //
  // H-1 or H-2 measured from the CURRENT hour — not one hour before `want`.
  // Those differ: inside the first ten minutes of an hour the settle delay has
  // already pushed `want` back to H-2, so `want - 1h` is H-3 on the wall clock.
  // A layer reopened after a long gap still holds whatever it had (eviction
  // skips the layer being asked for), and without this bound the header would
  // offer a three- or four-hour-old bucket as merely "stale".
  if (st.previous) {
    const oldest = hourFloor(now, offsetMinutes) - 2 * HOUR_MS;
    if (st.previous.hourStartMs >= oldest && st.previous.hourStartMs < want) {
      return { state: 'hit', bucket: st.previous, stale: true };
    }
    st.previous = null;
  }

  // 3 — cold: nothing older exists. Wait, but not for a whole scan.
  if (st.inflight) {
    const raced = await Promise.race([
      st.inflight.promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), COLD_WAIT_MS)),
    ]);
    if (raced) return { state: 'hit', bucket: raced, stale: false };
  }

  // 4 — the wanted hour was read and holds nothing, and there is no completed
  // hour to fall back on. The hour in progress, read live and never cached,
  // and not before it has had time to land.
  if (st.emptyHour === want) return readCurrentHour(st, layerKey, scan, now, offsetMinutes);

  // 5 — nothing held, and nothing said about why yet. A scan is running for
  // this hour, so the next request will have it: that, and only that, is
  // WARMING.
  return { state: st.inflight ? 'warming' : 'failed' };
}

/** Start the hour's scan unless one is already running for it. The result
 *  lands in `st` whether or not the request that started it is still waiting —
 *  that is the point: the work answers whoever asks next. */
function beginScan(st: LayerState, layerKey: string, scan: ScanFn, want: number): void {
  if (st.inflight && st.inflight.hourStartMs === want) return;
  const promise = scan(layerKey, want)
    .then(({ byService, unread, batches }) => {
      // A retry of an hour we already hold MERGES even when it read no values.
      // Exiting here would leave the held bucket's `unread` and its partial
      // flag untouched for the rest of the hour — a service the retry reached
      // and confirmed idle would stay marked unmeasured for good.
      if (!hasAnyValue(byService) && st.current?.hourStartMs === want) {
        const folded = mergeInto(st.current, {
          hourStartMs: want,
          byService,
          unread,
          batches,
          readAt: Date.now(),
        });
        st.current = folded;
        return folded;
      }
      if (!hasAnyValue(byService)) {
        // Read, but absent — remember the absence rather than the values, so
        // the whole fan-out is not spent again on a known answer. Two things
        // are NOT evidence of absence: a scan that lost batches, and an empty
        // re-read of an hour we already hold values for.
        if (batches.failed === 0 && st.current?.hourStartMs !== want) st.emptyHour = want;
        return null;
      }
      const read: KpiBucket = {
        hourStartMs: want,
        byService,
        unread,
        batches,
        readAt: Date.now(),
      };

      // A scan can finish AFTER the hour it was started for has passed — a slow
      // one, or a retry, landing once a newer hour is already held. Installing
      // it then would walk the header backwards, and take the newer hour's
      // fallback with it.
      if (st.current && st.current.hourStartMs > want) return read;

      // Same hour scanned twice — the retry after an incomplete read. MERGE
      // rather than replace: the two reads can lose different batches, and
      // overwriting would drop a service the first one did get in exchange for
      // one the second one did.
      const bucket = st.current?.hourStartMs === want ? mergeInto(st.current, read) : read;

      st.current = bucket;
      // The older hour existed only to be shown while THIS one loaded. Holding
      // it past that doubles what the layer costs — a second value per service
      // per metric — for a bucket nothing can ask for any more: the roll
      // repopulates it from `current` when the time comes.
      st.previous = null;
      return bucket;
    })
    .catch(() => null)
    .finally(() => {
      if (st.inflight?.hourStartMs === want) st.inflight = null;
    });
  st.inflight = { hourStartMs: want, promise };
}

/** The hour still being written, read live and never cached. See `partial`. */
async function readCurrentHour(
  st: LayerState,
  layerKey: string,
  scan: ScanFn,
  now: number,
  offsetMinutes: number,
): Promise<KpiRead> {
  // On the server's grid too — the hour in progress is one bucket there, and
  // one bucket is what the scan must ask for.
  const currentHourStart = hourFloor(now, offsetMinutes);
  if (now - currentHourStart < CURRENT_HOUR_SETTLE_MS) return { state: 'empty' };
  if (st.emptyCurrentHour === currentHourStart) return { state: 'empty' };
  if (st.emptyCurrentHour !== null && st.emptyCurrentHour !== currentHourStart) {
    st.emptyCurrentHour = null;
  }
  try {
    const { byService, unread, batches } = await scan(layerKey, currentHourStart);
    if (!hasAnyValue(byService)) {
      // Nothing at hour level anywhere, which on a young deployment means the
      // hour flush has simply not run yet. Say so once and let the caller read
      // the operator's own window instead of asking again every request.
      if (batches.failed === 0) st.emptyCurrentHour = currentHourStart;
      return { state: 'empty' };
    }
    return {
      bucket: {
        hourStartMs: currentHourStart,
        byService,
        unread,
        batches,
        readAt: Date.now(),
      },
      state: 'hit',
      stale: false,
      partial: true,
    };
  } catch {
    return { state: 'failed' };
  }
}

/** Does this bucket hold a single value? A bucket of nothing cannot rank
 *  services or fill a header, so the caller reads the operator's own window
 *  instead of presenting an empty hour as the answer. */
export function bucketHasValues(bucket: KpiBucket): boolean {
  return hasAnyValue(bucket.byService);
}

/**
 * Fold a fresh read of the SAME hour into the one already held.
 *
 * A value survives from whichever read got it: the later read wins where it has
 * one, and the earlier read's value is kept where the later one came back
 * empty for a service it could not reach. Replacing outright would trade a
 * service the first read measured for one the second did, leaving the hour no
 * more complete than before and possibly less.
 *
 * The result reports what is STILL missing, not what the last attempt missed —
 * a retry that filled every gap leaves an hour with nothing outstanding, and
 * saying otherwise would keep a warning on screen about a reading that is now
 * whole. "Missing" means UNREACHED, not valueless: a service the retry reached
 * and found idle is answered, and belongs with the idle ones in the ranking.
 */
function mergeInto(held: KpiBucket, fresh: KpiBucket): KpiBucket {
  const byService = new Map(held.byService);
  for (const [id, row] of fresh.byService) {
    const prev = byService.get(id);
    if (!prev) {
      byService.set(id, row);
      continue;
    }
    const merged: Record<string, number | null> = { ...prev };
    for (const [expr, v] of Object.entries(row)) if (v != null) merged[expr] = v;
    byService.set(id, merged);
  }
  // Unread follows whether the service was REACHED, not whether it had a value
  // to give. A retry that reaches a service and confirms it reported nothing has
  // resolved it: it is idle, not unmeasured, and must rank with the idle ones.
  // So a service stays unread only where BOTH reads missed it.
  const stillUnread = new Set([...held.unread].filter((id) => fresh.unread.has(id)));
  return {
    hourStartMs: held.hourStartMs,
    byService,
    unread: stillUnread,
    batches: {
      total: held.batches.total + fresh.batches.total,
      failed: stillUnread.size === 0 ? 0 : fresh.batches.failed,
    },
    readAt: fresh.readAt,
  };
}

/** Did the scan find anything? An hour every service answered `null` for is
 *  an hour OAP has no data in — a new install, or a layer nothing reported to
 *  yet — not a slow read to retry. */
function hasAnyValue(byService: Map<string, Record<string, number | null>>): boolean {
  for (const row of byService.values()) {
    for (const v of Object.values(row)) if (v != null) return true;
  }
  return false;
}

/** Rank + slice on cached scalars. No request: the values are already here,
 *  which is the whole point — ranking used to be the expensive half.
 *
 *  Generic over the row, because the roster reaches this from two shapes that
 *  spell the name differently; `nameOf` keeps the tie-break stable without
 *  this module having to know which one it was handed. */
export function rankFromCache<T extends { id: string }>(
  bucket: KpiBucket,
  services: T[],
  /** The MQE to rank on — the sort column's EXPRESSION, not its name. */
  orderByExpr: string,
  cap: number,
  nameOf: (s: T) => string,
): T[] {
  const valueOf = (s: T): number | null => bucket.byService.get(s.id)?.[orderByExpr] ?? null;
  // Same three tiers the live fan-out ranks by: measured first, then the ones
  // we FAILED to measure, then the ones that genuinely reported nothing. A
  // service we could not read is not an idle one, and sorting it last would
  // let a lost batch quietly evict the busiest service from the top-N.
  const tier = (s: T): 0 | 1 | 2 =>
    valueOf(s) != null ? 0 : bucket.unread.has(s.id) ? 1 : 2;
  return [...services]
    .sort((a, b) => {
      const ta = tier(a);
      const tb = tier(b);
      if (ta !== tb) return ta - tb;
      const av = valueOf(a);
      const bv = valueOf(b);
      if (av == null || bv == null) return nameOf(a).localeCompare(nameOf(b));
      return bv - av;
    })
    .slice(0, cap);
}
