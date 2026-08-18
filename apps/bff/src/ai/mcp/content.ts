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
 * Renders a captured {@link GraphicCard} as text the MODEL can reason over.
 *
 * A tool result has two channels: `content`, which the model reads, and
 * `structuredContent`, which a rendering host feeds to its UI. Whether a host
 * passes `structuredContent` to the model varies, so `content` cannot be a
 * caption — in a terminal it is the only thing that arrives, and a caption
 * like "1 series, 121 points" would leave the agent unable to see the spike it
 * was asked about.
 *
 * So each card is summarised into something diagnosable:
 *
 *  - **Bucketed min/avg/max**, not the raw series. `min 3 · avg 140.8 ·
 *    max 1285` in one bucket says *single outlier*; the same numbers averaged
 *    over the window say nothing, and the raw points cost tokens to say less.
 *  - **A log-scaled sparkline.** Latency is heavy-tailed: on a linear scale one
 *    spike flattens everything else onto the floor.
 *  - **Downsampled by MAX**, never mean — a mean erases the spike being
 *    investigated, which is the only reason anyone is reading this.
 */

import type { FigureXAxis, GraphicCard } from '../lib/graphic-card.js';

const BLOCKS = '▁▂▃▄▅▆▇█';
/** A bucket OAP reported nothing for. Distinct from the lowest block, because
 *  "no requests arrived" and "the value was at its floor" are different facts
 *  and a floor glyph asserts the second. */
const GAP = '·';
const SPARK_WIDTH = 48;
const BUCKETS = 12;

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 100) return String(Math.round(n));
  return (Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\.0*$|(\.\d*[1-9])0+$/, '$1');
}

type Point = number | null;

/** Downsample by MAX so a spike can never be averaged away. A slot is null
 *  only when EVERY point in it was null — one real value in the window is
 *  still a value. */
function downsample(values: Point[], width: number): Point[] {
  if (values.length <= width) return values;
  const per = values.length / width;
  return Array.from({ length: width }, (_, i) => {
    const from = Math.floor(i * per);
    const slice = values.slice(from, Math.max(Math.floor((i + 1) * per), from + 1));
    const present = slice.filter((v): v is number => v != null);
    return present.length ? Math.max(...present) : null;
  });
}

export function sparkline(values: Point[]): string {
  const pts = downsample(values, SPARK_WIDTH);
  const lg = (v: number): number => Math.log10(Math.max(v, 0) + 1);
  const xs = pts.filter((v): v is number => v != null).map(lg);
  if (!xs.length) return GAP.repeat(pts.length);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const span = hi - lo || 1;
  return pts.map((v) => (v == null ? GAP : BLOCKS[Math.min(7, Math.round(((lg(v) - lo) / span) * 7))])).join('');
}

/**
 * Bucket timestamps follow the STEP, not a fixed format. A DAY-step week
 * rendered as HH:MM prints the same clock time on every row — twelve identical
 * labels against twelve different values, which reads as a broken query rather
 * than a week of data.
 */
function at(x: FigureXAxis, i: number, n: number, offsetMinutes = 0): string {
  const t = n <= 1 ? x.endMs : x.startMs + ((x.endMs - x.startMs) * i) / (n - 1);
  // Rendered in the OAP SERVER's local time, not UTC. A DAY bucket is a
  // server-local day, so on a server at UTC+8 the UTC date names the previous
  // day for two thirds of it — a label that is wrong about which day the data
  // is from, on the one step where the day is the whole point.
  const iso = new Date(t + offsetMinutes * 60_000).toISOString();
  if (x.step === 'DAY') return iso.slice(0, 10);
  if (x.step === 'HOUR') return `${iso.slice(5, 10)} ${iso.slice(11, 13)}h`;
  return iso.slice(11, 16);
}

function describeSeries(name: string, data: Point[], x: FigureXAxis, offsetMinutes: number): string[] {
  const n = data.length;
  if (!n) return [`${name}: no points in the captured window`];
  const present = data.filter((v): v is number => v != null);
  const gaps = n - present.length;
  const stamp = (i: number): string => at(x, i, n, offsetMinutes);

  // Every bucket empty is not "zero" — it is a service that reported nothing.
  // Saying 0 would have the model diagnose a healthy idle service as an outage,
  // or a latency metric as having dropped to nothing.
  if (!present.length) {
    return [`${name} — ${n} buckets, ${stamp(0)}–${stamp(n - 1)}, NO DATA in any of them`];
  }

  const sorted = [...present].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const max = Math.max(...present);
  const min = Math.min(...present);
  const iMax = data.indexOf(max);

  const out = [
    `${name} — ${n} points, ${stamp(0)}–${stamp(n - 1)}`,
    `  ${sparkline(data)}   (log scale${gaps ? `, ${GAP} = no data` : ''})`,
    `  median ${fmt(median)} · p95 ${fmt(p95)} · min ${fmt(min)} · max ${fmt(max)} at ${stamp(iMax)}`,
  ];
  // Stated, not implied by a gap in a glyph row the model may not parse.
  if (gaps) out.push(`  ${gaps} of ${n} buckets reported no data (excluded from the statistics above)`);
  if (median > 0 && max / median >= 5) {
    out.push(`  peak is ${Math.round(max / median)}x the median — check whether it is one bucket or a shift`);
  }

  const per = n / BUCKETS;
  if (n >= BUCKETS * 2) {
    out.push('  bucket         min     avg     max');
    for (let b = 0; b < BUCKETS; b++) {
      const slice = data.slice(Math.floor(b * per), Math.floor((b + 1) * per));
      if (!slice.length) continue;
      const vals = slice.filter((v): v is number => v != null);
      const label = stamp(Math.floor(b * per)).padEnd(12);
      // An all-empty bucket prints dashes. Math.min of an empty array is
      // Infinity, which would render as a number and read as real.
      out.push(
        vals.length
          ? `  ${label}${fmt(Math.min(...vals)).padStart(6)}  ` +
            `${fmt(vals.reduce((a, c) => a + c, 0) / vals.length).padStart(6)}  ` +
            `${fmt(Math.max(...vals)).padStart(6)}`
          : `  ${label}${'—'.padStart(6)}  ${'—'.padStart(6)}  ${'—'.padStart(6)}`,
      );
    }
  }
  return out;
}

/**
 * ISO instant, second precision, in the OAP SERVER's local time — for row
 * timestamps, where the bucket-label rules above do not apply.
 *
 * The offset is not optional decoration. Figure buckets are rendered
 * server-local (see `at`), so a row stamped in UTC put two clocks in one
 * answer: on a server at UTC+8 a log line and the chart bucket it belongs to
 * were eight hours apart, and the model correlating them concluded the wrong
 * thing. It also broke the project rule that every time string Horizon emits
 * is OAP-server local.
 */
function stamp(ms: number, offsetMinutes = 0): string {
  return new Date(ms + offsetMinutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

/** OAP sends a native trace's start as a string that is epoch millis on every
 *  backend seen so far — but it is typed as a string, so anything unparseable
 *  passes through rather than becoming "Invalid Date". */
function stampLoose(s: string, offsetMinutes = 0): string {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? stamp(n, offsetMinutes) : s;
}

/**
 * Row caps, and why they are STATED rather than silent.
 *
 * A capture holds up to 100 log rows because the panel's operator scrolls them.
 * Feeding all 100 to a model costs roughly 4K tokens for one call, so the text
 * rendering caps — and names both the total and WHICH rows it kept. An agent
 * that reads "100 rows — showing the most recent 50" knows its view is partial
 * and can re-query; one silently handed 50 of 100 reports on half the evidence
 * and calls it complete.
 */
const ROW_CAPS = { traces: 25, logs: 50, browserErrors: 40, podLogs: 60 } as const;

function capNote(shown: number, total: number, what: string, kept: string): string {
  return shown >= total ? `${total} ${what}:` : `${total} ${what} — showing ${kept} ${shown}:`;
}

/**
 * The four triage lists.
 *
 * In the panel the operator BROWSES these and the tool's text is a pointer
 * ("captured 30 traces, open one to see its waterfall"). An MCP agent has no
 * list to browse, so without this the only answer to "show me the failing
 * requests" would be the number 30 — the rows are captured in `replayData` and
 * would go unread. Rendered widest-signal-first (errors, slowest) because the
 * cap bites long before a busy service's traffic does.
 */
function describeLists(card: GraphicCard, offsetMinutes = 0): string | null {
  if (card.type === 'traces') {
    const rows = card.spec.replayData?.native?.traces ?? [];
    if (!rows.length) return null;
    const sorted = [...rows].sort((a, b) => Number(b.isError) - Number(a.isError) || b.duration - a.duration);
    const shown = sorted.slice(0, ROW_CAPS.traces);
    return [
      capNote(shown.length, rows.length, 'trace(s), errors first then slowest', 'the top'),
      ...shown.map((r) => {
        const spans = r.spans?.length ? `, ${r.spans.length} spans` : '';
        return `  ${r.isError ? 'ERROR' : '  ok '}  ${String(r.duration).padStart(6)} ms  ${stampLoose(r.start, offsetMinutes)}  ${r.endpointNames.join(' / ')}  [${r.traceIds[0] ?? r.segmentId}${spans}]`;
      }),
    ].join('\n');
  }
  if (card.type === 'zipkin-traces') {
    const rows = card.spec.replayData?.traces ?? [];
    if (!rows.length) return null;
    const sorted = [...rows].sort((a, b) => b.errorCount - a.errorCount || (b.duration ?? 0) - (a.duration ?? 0));
    const shown = sorted.slice(0, ROW_CAPS.traces);
    return [
      capNote(shown.length, rows.length, 'Zipkin trace(s), errors first then slowest', 'the top'),
      ...shown.map(
        (r) =>
          `  ${r.errorCount ? `${r.errorCount} err` : '  ok  '}  ${String(Math.round((r.duration ?? 0) / 1000)).padStart(6)} ms  ` +
          `${r.timestamp ? stamp(Math.round(r.timestamp / 1000), offsetMinutes) : '—'}  ${r.rootService ?? '?'} ${r.rootName ?? ''}  [${r.traceId}, ${r.spanCount} spans]`,
      ),
    ].join('\n');
  }
  if (card.type === 'logs') {
    const rows = card.spec.replayData?.logs ?? [];
    if (!rows.length) return null;
    // OAP's log order is newest-first; sorted ascending here so the rows read
    // like a tail, and the cap keeps the MOST RECENT ones (the tail is where an
    // incident is, not the top of the page).
    const asc = [...rows].sort((a, b) => a.timestamp - b.timestamp);
    const shown = asc.slice(-ROW_CAPS.logs);
    return [
      capNote(shown.length, rows.length, 'log row(s), oldest to newest', 'the most recent'),
      ...shown.map((r) => {
        const where = [r.serviceInstanceName, r.endpointName].filter(Boolean).join(' ');
        // Log content is arbitrary length and often multi-line; one row per
        // line keeps the transcript readable and the token cost bounded.
        const content = r.content.replace(/\s+/g, ' ').slice(0, 240);
        return `  ${stamp(r.timestamp, offsetMinutes)}  ${where ? `${where}  ` : ''}${content}${r.traceId ? `  [trace ${r.traceId}]` : ''}`;
      }),
    ].join('\n');
  }
  if (card.type === 'browser-errors') {
    const rows = card.spec.replayData?.logs ?? [];
    if (!rows.length) return null;
    const shown = rows.slice(0, ROW_CAPS.browserErrors);
    return [
      capNote(shown.length, rows.length, 'browser error(s)', 'the first'),
      ...shown.map(
        (r) =>
          `  ${stamp(r.time, offsetMinutes)}  ${r.category}  ${r.pagePath}  ${(r.message ?? '').replace(/\s+/g, ' ').slice(0, 200)}` +
          `${r.line ? ` (line ${r.line}:${r.col ?? 0})` : ''}`,
      ),
    ].join('\n');
  }
  return null;
}

/**
 * One card as analysable text, or `null` when the tool's own return already
 * says everything the card holds.
 *
 * `null` is the common case for the map cards: their tools return a full
 * metric-bearing sentence ("Focus X: RPM …, upstream A (edge p95 …)") because
 * the model needs those numbers even in the panel, where the operator has the
 * picture. Re-listing the peer names under it would cost tokens to say less.
 */
export function describeCard(card: GraphicCard, offsetMinutes = 0): string | null {
  const list = describeLists(card, offsetMinutes);
  if (list) return list;

  switch (card.type) {
    case 'figure': {
      const lines: string[] = [];
      for (const f of card.figures) {
        const { spec, result, xaxis } = f;
        lines.push(`${spec.title ?? 'figure'}${spec.unit ? ` (${spec.unit})` : ''} — mqe: ${(spec.expressions ?? []).join(', ')}`);
        if (spec.tip) lines.push(`  ${spec.tip}`);
        if (result.error) {
          lines.push(`  read failed: ${result.error}`);
        } else if (spec.type === 'card') {
          lines.push(`  value: ${result.value == null ? 'no value in the captured window' : fmt(result.value)}`);
        } else if (result.series?.length && xaxis) {
          for (const s of result.series) lines.push(...describeSeries(s.label, s.data, xaxis, offsetMinutes));
        } else if (result.topList?.length) {
          lines.push(...result.topList.slice(0, 15).map((r) => `  ${r.name}  ${fmt(r.value ?? NaN)}`));
        } else if (result.table?.length) {
          lines.push(...result.table.slice(0, 15).map((r) => `  ${r.labels ?? ''}  ${fmt(Number(r.value))}`));
        } else if (result.records?.length) {
          lines.push(...result.records.slice(0, 15).map((r) => `  ${r.name}  ${fmt(Number(r.value))}`));
        } else {
          lines.push('  no data in the captured window');
        }
      }
      return lines.join('\n');
    }
    case 'hierarchy':
      return [
        `${card.spec.title} — ${card.spec.service} across layers`,
        ...card.spec.groups.map((g) => `  ${g.layer}: ${g.peers.map((p) => p.name).join(', ')}`),
      ].join('\n');
    case 'podlogs': {
      // The TAIL, not the head. These arrive oldest-first and the interesting
      // end of a pod log is the recent end — taking the first 40 showed the
      // container's startup banner while the tool's own text promised a tail.
      const lines = card.spec.initialLines;
      const shown = lines.slice(-ROW_CAPS.podLogs);
      return [
        `${card.spec.title} — ${card.spec.pod ?? 'pod'} / ${card.spec.container}`,
        ...(card.spec.errorReason ? [`  ${card.spec.errorReason}`] : []),
        capNote(shown.length, lines.length, 'line(s)', 'the most recent'),
        // Pod logs are the one untrusted stream rendered without collapsing
        // whitespace, so a line of its own keeps a multi-line stack readable.
        ...shown.map((l) => `  ${l.content.replace(/\s+$/, '')}`),
      ].join('\n');
    }
    case 'proposal':
      return [
        `PROPOSED (not started): ${card.spec.profilingType} profiling on ${card.spec.service}`,
        `  cause      : ${card.spec.cause}`,
        `  rationale  : ${card.spec.rationale}`,
        `  expectation: ${card.spec.expectation}`,
        `  parameters : layer=${card.spec.layer} duration=${card.spec.durationMinutes}m` +
          `${card.spec.endpoint ? ` endpoint=${card.spec.endpoint}` : ''}` +
          `${card.spec.instanceLabel ? ` target=${card.spec.instanceLabel}` : ''}`,
        '  NOTHING HAS STARTED. The operator must start this in Horizon\'s profiling tab.',
      ].join('\n');
    default:
      // The map cards (topology, deployment, instance-topology,
      // endpoint-dependency, process-topology) and the profiling flame: their
      // tools already return the metrics and the analysis as prose, so there is
      // nothing here to add.
      return null;
  }
}
