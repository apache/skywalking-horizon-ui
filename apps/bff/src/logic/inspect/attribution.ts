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
 * Build an in-process index of `metric name → { source, file }`.
 *
 * SWIP-14's `/inspect/metrics` does not return rule provenance — the
 * catalog only knows type / scope / downsamplings. Studio cross-
 * references that catalog against the rule files it already manages
 * (via the existing `/runtime/oal/*` and `/runtime/rule/*` admin
 * APIs) to add a `source` + `file` dimension that the operator can
 * use to filter the Inspect board's catalog drawer.
 *
 * Fingerprint: `oalFiles[]` (list of file names) + `runtime/rule/list`
 * rows (each row carries `contentHash`). The cache rebuilds whenever
 * any input changes; an explicit `refresh()` busts the cache so the
 * SPA's manual refresh button picks up newly added rules.
 */

import type { OalClient, RuntimeRuleClient } from '@skywalking-horizon-ui/api-client';
import { parseOalMetricNames } from './parser-oal.js';
import { parseMalMetricNames } from './parser-mal.js';

export type AttributionSource = 'OAL' | 'MAL·OTEL' | 'MAL·Telegraf' | 'LAL→MAL' | 'unknown';

export interface MetricAttribution {
  source: AttributionSource;
  /** Full file path, e.g. `core.oal`, `otel-rules/jvm-memory`,
   *  `telegraf-rules/cpu`, `log-mal-rules/log-status`. Includes the
   *  catalog prefix for MAL/LAL→MAL so different catalogs don't
   *  collide on duplicate file names. `null` only when a metric has
   *  multiple ambiguous owners (currently rare). */
  file: string | null;
  /** Populated when more than one rule file claimed this metric;
   *  empty otherwise. Lets the SPA surface "ambiguous" with the
   *  candidate list. */
  candidates?: string[];
}

export interface AttributionIndex {
  /** Stringly fingerprint of the inputs that produced this index.
   *  Two indexes are interchangeable iff their fingerprints match. */
  fingerprint: string;
  /** Metric name → attribution. Unknown metrics are not in the map;
   *  callers should default to `source: 'unknown', file: null`. */
  byMetric: Map<string, MetricAttribution>;
}

export interface AttributionDeps {
  oal(): OalClient;
  rules(): RuntimeRuleClient;
}

interface CacheState {
  index: AttributionIndex | null;
  /** A second-tier guard against thundering-herd rebuilds: while a
   *  rebuild is in flight, every caller awaits the same promise. */
  inflight: Promise<AttributionIndex> | null;
}

export class AttributionCache {
  private state: CacheState = { index: null, inflight: null };

  /** Force the next call to `get()` to fully rebuild the index. */
  invalidate(): void {
    this.state = { index: null, inflight: null };
  }

  /** Returns the cached index when its fingerprint still matches the
   *  current inputs; rebuilds otherwise. Concurrent callers share one
   *  in-flight rebuild. */
  async get(deps: AttributionDeps): Promise<AttributionIndex> {
    const cached = this.state.index;
    if (cached) {
      try {
        const fp = await computeFingerprint(deps);
        if (fp === cached.fingerprint) return cached;
      } catch {
        // If fingerprint computation fails (admin unreachable), serve
        // the stale index — the catalog endpoints would have failed
        // by now anyway, so this only matters when admin recovers.
        return cached;
      }
    }
    if (this.state.inflight) return this.state.inflight;
    const p = buildIndex(deps).then((idx) => {
      this.state = { index: idx, inflight: null };
      return idx;
    });
    this.state.inflight = p;
    return p;
  }
}

const MAL_CATALOGS = ['otel-rules', 'telegraf-rules', 'log-mal-rules'] as const;

/** Compute a fingerprint that uniquely identifies the current rule
 *  set. Either side is best-effort — if `/runtime/oal/*` or
 *  `/runtime/rule/*` is disabled on this OAP, that side is treated
 *  as empty rather than failing the whole attribution.
 *
 *  We fingerprint over:
 *   - the list of OAL file names (their content only changes on OAP
 *     restart, so the file list is a sufficient proxy);
 *   - runtime-rule rows from `/runtime/rule/list` (operator-pushed
 *     + already-touched bundled rules; each carries a contentHash);
 *   - bundled rule names + content hashes from
 *     `/runtime/rule/bundled?catalog=...` for each MAL catalog (the
 *     baked-in defaults, almost always the bulk of MAL attribution).
 */
async function computeFingerprint(deps: AttributionDeps): Promise<string> {
  const rules = deps.rules();
  const [oalFiles, malRuntimeRows, ...bundledLists] = await Promise.all([
    deps
      .oal()
      .listFiles()
      .then((r) => r.files)
      .catch(() => [] as string[]),
    rules
      .list()
      .then((r) => r.rules.map((row) => `${row.catalog}/${row.name}@${row.contentHash}`))
      .catch(() => [] as string[]),
    ...MAL_CATALOGS.map((c) =>
      rules
        .listBundled(c, false)
        .then((rows) => rows.map((b) => `${c}/${b.name}@${b.contentHash}`))
        .catch(() => [] as string[]),
    ),
  ]);
  const oalPart = [...oalFiles].sort().join('|');
  const runtimePart = [...malRuntimeRows].sort().join('|');
  const bundledPart = bundledLists.flat().sort().join('|');
  return `oal:${oalPart}||rt:${runtimePart}||bn:${bundledPart}`;
}

async function buildIndex(deps: AttributionDeps): Promise<AttributionIndex> {
  const oal = deps.oal();
  const rules = deps.rules();

  // Pull every rule source in parallel. Each side is best-effort —
  // when an OAP module is disabled (e.g. `SW_RECEIVER_RUNTIME_RULE`
  // unset), the call fails and we drop that bucket without failing
  // the whole attribution.
  const [filesEnvSafe, listEnvSafe, ...bundledLists] = await Promise.all([
    oal.listFiles().catch(() => ({ files: [] as string[], count: 0 })),
    rules.list().catch(() => ({
      generatedAt: 0,
      loaderStats: { active: 0, pending: 0 },
      rules: [] as Awaited<ReturnType<typeof rules.list>>['rules'],
    })),
    ...MAL_CATALOGS.map((c) =>
      rules
        .listBundled(c, true)
        .then((rows) => ({ catalog: c, rows }))
        .catch(() => ({ catalog: c, rows: [] })),
    ),
  ]);

  // Per-file getFileContent errors are tolerated.
  const oalContents = await Promise.all(
    filesEnvSafe.files.map(async (name) => {
      try {
        return { name, content: await oal.getFileContent(name) };
      } catch {
        return { name, content: null };
      }
    }),
  );

  /* MAL: combine runtime + bundled sources.
   *
   * 1. `/runtime/rule/list` rows are operator-pushed runtime rules
   *    plus bundled rules the dslManager has already touched. We
   *    fetch their content via `/runtime/rule?catalog=…&name=…`.
   * 2. `/runtime/rule/bundled?catalog=…&withContent=true` gives us
   *    every baked-in rule for each MAL catalog, with content inline
   *    — no per-rule fetch needed. This is the bulk of attribution
   *    in a vanilla OAP install.
   *
   * `lal` is excluded — LAL files emit logs (not metrics); the
   * `log-mal-rules` catalog covers the LAL→MAL bridge metrics. */
  const malRuntimeRows = listEnvSafe.rules.filter((r) => r.catalog !== 'lal');
  const malRuntimeContents = await Promise.all(
    malRuntimeRows.map(async (row) => {
      try {
        const got = await rules.get({ catalog: row.catalog, name: row.name });
        if ('notModified' in got) return { catalog: row.catalog, name: row.name, content: null };
        return { catalog: row.catalog, name: row.name, content: got.content };
      } catch {
        return { catalog: row.catalog, name: row.name, content: null };
      }
    }),
  );

  const malBundledContents = bundledLists.flatMap((b) =>
    b.rows.map((row) => ({ catalog: b.catalog, name: row.name, content: row.content ?? null })),
  );

  const malContents = [...malRuntimeContents, ...malBundledContents];

  // Detect conflicts (one metric claimed by multiple files) so the SPA
  // can surface them.
  const byMetric = new Map<string, MetricAttribution>();
  const claims = new Map<string, { source: AttributionSource; file: string }[]>();

  const claim = (metric: string, source: AttributionSource, file: string) => {
    const arr = claims.get(metric) ?? [];
    arr.push({ source, file });
    claims.set(metric, arr);
  };

  for (const { name, content } of oalContents) {
    if (content === null) continue;
    for (const m of parseOalMetricNames(content)) claim(m, 'OAL', name);
  }

  /* Dedup runtime + bundled (an operator-pushed override and the
   * underlying bundled twin are the same logical file; we just want
   * the metric → file mapping, not version tracking). */
  const seenMal = new Set<string>();
  for (const { catalog, name, content } of malContents) {
    if (content === null) continue;
    const file = `${catalog}/${name}`;
    if (seenMal.has(file)) continue;
    seenMal.add(file);
    const source: AttributionSource =
      catalog === 'otel-rules'
        ? 'MAL·OTEL'
        : catalog === 'telegraf-rules'
          ? 'MAL·Telegraf'
          : catalog === 'log-mal-rules'
            ? 'LAL→MAL'
            : 'unknown';
    for (const m of parseMalMetricNames(content)) claim(m, source, file);
  }

  for (const [metric, arr] of claims) {
    if (arr.length === 1) {
      const only = arr[0]!;
      byMetric.set(metric, { source: only.source, file: only.file });
    } else {
      // Ambiguous: keep the first claim's source for display, expose
      // the full candidate list. (In practice this should be zero —
      // OAL and MAL use disjoint name spaces — but the UI is honest.)
      const first = arr[0]!;
      byMetric.set(metric, {
        source: first.source,
        file: first.file,
        candidates: arr.map((c) => `${c.source}:${c.file}`),
      });
    }
  }

  const fingerprint = await computeFingerprint(deps);
  return { fingerprint, byMetric };
}

/** Look up a metric and fall back to `unknown` when the metric is
 *  not in the index (typical for OAP-bundled core metrics that Studio
 *  doesn't manage — though /runtime/oal/files does return those too,
 *  so the fallthrough is rare). */
export function attributeOrUnknown(index: AttributionIndex, metric: string): MetricAttribution {
  return index.byMetric.get(metric) ?? { source: 'unknown', file: null };
}
