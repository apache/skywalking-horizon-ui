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

import { describe, it, expect } from 'vitest';
import { describeCard, sparkline } from './content.js';
import type { GraphicCard } from '../lib/graphic-card.js';

const DAY = 86_400_000;

function figure(data: Array<number | null>, step: 'MINUTE' | 'HOUR' | 'DAY', spanMs: number): GraphicCard {
  const endMs = Date.UTC(2026, 7, 18, 12, 0, 0);
  return {
    type: 'figure',
    n: 1,
    figures: [
      {
        spec: { id: 'w', title: 'latency', type: 'line', expressions: ['service_resp_time'], unit: 'ms' },
        result: { series: [{ label: 'latency', data }] },
        xaxis: { startMs: endMs - spanMs, endMs, step },
      },
    ],
  } as unknown as GraphicCard;
}

describe('a series is rendered so a model can diagnose from it', () => {
  // The whole reason the raw series is not sent: a spike averaged into the
  // window reads as a healthy service. Downsampling by MAX is what preserves it.
  it('keeps a single spike visible after downsampling', () => {
    const flat = Array.from({ length: 400 }, () => 5);
    flat[200] = 1285;
    const text = describeCard(figure(flat, 'MINUTE', 400 * 60_000)) ?? '';
    expect(text).toContain('max 1285');
    expect(text).toContain('peak is 257x the median');
    // The glyph row must show it too — a mean-downsample would flatten 1285
    // into one 48th of the window and print an unbroken floor.
    const spark = text.split('\n').find((l) => l.includes('█'));
    expect(spark).toBeDefined();
  });

  it('reports no-value windows as such rather than as zero', () => {
    const card = {
      type: 'figure',
      n: 1,
      figures: [
        {
          spec: { id: 'w', title: 'peak', type: 'card', expressions: ['max(service_resp_time)'] },
          result: { value: null },
        },
      ],
    } as unknown as GraphicCard;
    expect(describeCard(card)).toContain('no value in the captured window');
  });

  // A DAY-step week printed as HH:MM gives twelve identical labels against
  // twelve different values, which reads as a broken query.
  it('labels buckets at the precision the step actually has', () => {
    const week = Array.from({ length: 7 }, (_, i) => i + 1);
    expect(describeCard(figure(week, 'DAY', 7 * DAY))).toMatch(/2026-08-1[12]/);

    const hours = Array.from({ length: 48 }, (_, i) => i + 1);
    expect(describeCard(figure(hours, 'HOUR', 48 * 3_600_000))).toMatch(/08-1[67] \d\dh/);

    const mins = Array.from({ length: 60 }, (_, i) => i + 1);
    expect(describeCard(figure(mins, 'MINUTE', 60 * 60_000))).toMatch(/1[12]:\d\d/);
  });

  /**
   * OAP returns null for a bucket it has no data for. Coercing that to 0 made
   * an idle service read as one reporting zero — for a latency metric, "it
   * dropped to nothing" rather than "nobody called it". The statistics must
   * exclude them, and the gap must be stated rather than left implied by a
   * glyph the model may not parse.
   */
  it('excludes no-data buckets from the statistics and says how many there were', () => {
    const data = [5, null, 5, null, 5, 5, null, 5];
    const text = describeCard(figure(data, 'MINUTE', 8 * 60_000)) ?? '';
    expect(text).toContain('min 5');
    expect(text).not.toMatch(/min 0\b/);
    expect(text).toContain('3 of 8 buckets reported no data');
    expect(text).toContain('· = no data');
  });

  it('says NO DATA rather than zero when every bucket is empty', () => {
    const text = describeCard(figure([null, null, null], 'MINUTE', 3 * 60_000)) ?? '';
    expect(text).toContain('NO DATA in any of them');
    expect(text).not.toMatch(/median|min |max /);
  });

  it('marks a no-data bucket in the table with a dash, never Infinity', () => {
    // Math.min of an empty array is Infinity, which renders as a number and
    // reads as a real measurement.
    const data = [...Array(12).fill(7), ...Array(12).fill(null)] as Array<number | null>;
    const text = describeCard(figure(data, 'MINUTE', 24 * 60_000)) ?? '';
    expect(text).not.toContain('Infinity');
    expect(text).toContain('—');
  });

  it('shows gaps in the sparkline rather than a floor', () => {
    expect(sparkline([5, null, 5])).toBe('▁·▁');
    expect(sparkline([null, null])).toBe('··');
  });

  it('renders a flat series without dividing by zero', () => {
    expect(sparkline([7, 7, 7, 7])).toBe('▁▁▁▁');
    expect(sparkline([])).toBe('');
  });
});

describe('captured lists reach the model, not just their row count', () => {
  const traces = {
    type: 'traces',
    n: 1,
    spec: {
      title: 'traces',
      layer: 'GENERAL',
      service: 'agent::songs',
      replayData: {
        generatedAt: 0,
        source: 'native',
        native: {
          source: 'native',
          api: 'queryTraces',
          hasNext: false,
          reachable: true,
          traces: [
            { key: 'a', segmentId: 's1', endpointNames: ['/fast'], duration: 12, start: '1787014864014', isError: false, traceIds: ['t-fast'] },
            { key: 'b', segmentId: 's2', endpointNames: ['/slow'], duration: 980, start: '1787014864999', isError: false, traceIds: ['t-slow'] },
            { key: 'c', segmentId: 's3', endpointNames: ['/broken'], duration: 30, start: 'not-a-number', isError: true, traceIds: ['t-err'] },
          ],
        },
      },
    },
  } as unknown as GraphicCard;

  // Without this the answer to "show me the failing requests" is the number 3:
  // the rows ride in replayData for the panel to draw and would go unread.
  it('lists errors first, then the slowest', () => {
    const lines = (describeCard(traces) ?? '').split('\n');
    expect(lines[1]).toContain('t-err');
    expect(lines[2]).toContain('t-slow');
    expect(lines[3]).toContain('t-fast');
  });

  it('renders epoch-millis starts as instants and passes anything else through', () => {
    const text = describeCard(traces) ?? '';
    expect(text).toContain('2026-08-18');
    expect(text).toContain('not-a-number');
  });

  it('states the total and which rows survived the cap', () => {
    const many = {
      ...traces,
      spec: {
        ...(traces as unknown as { spec: Record<string, unknown> }).spec,
        replayData: {
          generatedAt: 0,
          source: 'native',
          native: {
            source: 'native',
            api: 'queryTraces',
            hasNext: false,
            reachable: true,
            traces: Array.from({ length: 30 }, (_, i) => ({
              key: `k${i}`, segmentId: `s${i}`, endpointNames: ['/e'], duration: i,
              start: '1787014864014', isError: false, traceIds: [`t${i}`],
            })),
          },
        },
      },
    } as unknown as GraphicCard;
    const head = (describeCard(many) ?? '').split('\n')[0];
    expect(head).toContain('30 trace(s)');
    expect(head).toContain('showing the top 25');
  });

  it('keeps the most recent logs, not the oldest, and says so', () => {
    const base = Date.UTC(2026, 7, 18, 0, 0, 0);
    const card = {
      type: 'logs',
      n: 1,
      spec: {
        title: 'logs',
        layer: 'GENERAL',
        service: 'agent::songs',
        replayData: {
          generatedAt: 0, query: {}, pageNum: 1, pageSize: 100, hasNext: false, reachable: true,
          // OAP hands these back newest-first; the renderer must not trust that.
          logs: Array.from({ length: 100 }, (_, i) => ({
            serviceName: 'agent::songs', serviceId: null, serviceInstanceName: 'inst',
            serviceInstanceId: null, endpointName: null, endpointId: null, traceId: null,
            timestamp: base + (99 - i) * 1000, contentType: 'text/plain', content: `line ${99 - i}`, tags: [],
          })),
        },
      },
    } as unknown as GraphicCard;
    const lines = (describeCard(card) ?? '').split('\n');
    expect(lines[0]).toContain('100 log row(s)');
    expect(lines[0]).toContain('showing the most recent 50');
    expect(lines[1]).toContain('line 50');
    expect(lines[lines.length - 1]).toContain('line 99');
  });
});

describe('a card that adds nothing to its tool reply says nothing', () => {
  // The map tools already return every metric as prose, so re-listing the peer
  // names underneath costs tokens to say strictly less.
  it.each(['topology', 'deployment', 'instance-topology', 'endpoint-dependency'])('%s', (type) => {
    expect(describeCard({ type, n: 1, spec: { title: 't' } } as unknown as GraphicCard)).toBeNull();
  });

  it('and an empty captured list falls back to the tool reply too', () => {
    const empty = {
      type: 'logs',
      n: 1,
      spec: { title: 'logs', layer: 'GENERAL', service: 's', replayData: { logs: [] } },
    } as unknown as GraphicCard;
    expect(describeCard(empty)).toBeNull();
  });
});

/**
 * A figure bucket and a log row in the same answer must name the same clock.
 * They did not: buckets went through the offset, rows through a bare
 * toISOString, and on a UTC+8 server the two were eight hours apart in one
 * result — which is exactly the correlation an agent is asked to make.
 */
describe('one result speaks one clock', () => {
  const logCard = {
    type: 'logs',
    spec: { replayData: { logs: [{ timestamp: Date.UTC(2026, 0, 2, 1, 0, 0), content: 'boom', serviceName: 's' }] } },
  } as never;

  it('renders row timestamps in the OAP server clock, not UTC', () => {
    const utc = describeCard(logCard, 0) ?? '';
    const plus8 = describeCard(logCard, 480) ?? '';
    expect(utc).toContain('2026-01-02 01:00:00');
    expect(plus8).toContain('2026-01-02 09:00:00');
    expect(plus8).not.toContain('2026-01-02 01:00:00');
  });
});
