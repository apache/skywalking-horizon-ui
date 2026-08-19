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
 * Every card kind is accounted for over MCP — either it renders itself into the
 * text the model reads, or it is deliberately silent because its tool already
 * returned the same information as prose.
 *
 * The point is that a NEW card kind cannot be added without deciding which it
 * is. Without this, a kind added later inherits `null` from the default branch
 * and an agent silently receives a tool reply with the data missing.
 */

import { describe, it, expect } from 'vitest';
import { describeCard } from './content.js';
import type { GraphicCard } from '../lib/graphic-card.js';

/**
 * `renders` — describeCard adds what the tool reply does not carry.
 * `tool-text` — the tool already returns the metrics as prose (all five map
 * cards do), so adding a weaker restatement costs tokens to say less.
 */
const KINDS: Record<string, 'renders' | 'tool-text'> = {
  figure: 'renders',
  traces: 'renders',
  'zipkin-traces': 'renders',
  logs: 'renders',
  'browser-errors': 'renders',
  hierarchy: 'renders',
  podlogs: 'renders',
  proposal: 'renders',
  topology: 'tool-text',
  deployment: 'tool-text',
  'instance-topology': 'tool-text',
  'endpoint-dependency': 'tool-text',
  'process-topology': 'tool-text',
  profiling: 'tool-text',
};

/** A card of `kind` carrying the least its renderer needs. */
function sample(kind: string): GraphicCard {
  const base = { type: kind, n: 1, capturedAt: Date.UTC(2026, 7, 18) };
  switch (kind) {
    case 'figure':
      return { ...base, figures: [{ spec: { title: 'rt', type: 'card', expressions: ['x'] }, result: { value: 5 } }] } as unknown as GraphicCard;
    case 'traces':
      return { ...base, spec: { title: 't', layer: 'L', service: 's', replayData: { native: { traces: [
        { key: 'a', segmentId: 's1', endpointNames: ['/e'], duration: 9, start: '1787000000000', isError: true, traceIds: ['t1'] }] } } } } as unknown as GraphicCard;
    case 'zipkin-traces':
      return { ...base, spec: { title: 't', layer: 'L', service: 's', replayData: { traces: [
        { traceId: 'z1', rootName: 'GET /x', rootService: 'svc', timestamp: 1787000000000000, duration: 9000, spanCount: 3, errorCount: 1 }] } } } as unknown as GraphicCard;
    case 'logs':
      return { ...base, spec: { title: 'l', layer: 'L', service: 's', replayData: { logs: [
        { serviceName: 's', serviceInstanceName: 'i', endpointName: null, traceId: null, timestamp: 1787000000000, contentType: 'text/plain', content: 'boom', tags: [] }] } } } as unknown as GraphicCard;
    case 'browser-errors':
      return { ...base, spec: { title: 'b', layer: 'L', service: 's', replayData: { logs: [
        { service: 's', serviceVersion: '1', time: 1787000000000, pagePath: '/p', category: 'JS', grade: null, message: 'x is not a function', line: 4, col: 2, stack: null, errorUrl: null, firstReportedError: true }] } } } as unknown as GraphicCard;
    case 'hierarchy':
      return { ...base, spec: { title: 'h', service: 's', groups: [{ layer: 'MESH', peers: [{ name: 'p' }] }] } } as unknown as GraphicCard;
    case 'podlogs':
      return { ...base, spec: { title: 'p', container: 'c', pod: 'pod-1', initialLines: [{ content: 'line' }] } } as unknown as GraphicCard;
    case 'proposal':
      return { ...base, spec: { kind: 'profiling', profilingType: 'trace', layer: 'L', service: 's', durationMinutes: 10,
        cause: 'c', rationale: 'r', expectation: 'e' } } as unknown as GraphicCard;
    default:
      return { ...base, spec: { title: kind, service: 's', layer: 'L' } } as unknown as GraphicCard;
  }
}

describe('every card kind is accounted for in what the model reads', () => {
  it.each(Object.entries(KINDS))('%s → %s', (kind, expected) => {
    const out = describeCard(sample(kind));
    if (expected === 'renders') {
      expect(out, `${kind} must render something the tool reply does not carry`).toBeTruthy();
      expect(out!.length).toBeGreaterThan(10);
    } else {
      expect(out, `${kind}'s tool already returns its metrics as prose`).toBeNull();
    }
  });

  // The list that has to be maintained. A kind added to the union without a
  // decision here fails this, rather than silently reaching the model empty.
  it('covers every kind the BFF can emit', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../lib/graphic-card.ts', import.meta.url), 'utf8'));
    // Only the GraphicCard union — `StreamEvent` below it adds the control
    // events (token / thinking / …), which are not cards and render nothing.
    const union = /export type GraphicCard =([\s\S]*?);\n/.exec(src)?.[1] ?? '';
    const emitted = [...union.matchAll(/type: '([a-z-]+)'/g)].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(10);
    expect([...new Set(emitted)].sort()).toEqual(Object.keys(KINDS).sort());
  });

  // The card kinds a public demo cannot produce still have to render honestly.
  it('renders a no-data capture as a no-data statement, never as zero', () => {
    const empty = { type: 'figure', n: 1, figures: [
      { spec: { title: 'rt', type: 'card', expressions: ['x'] }, result: { value: null } }] } as unknown as GraphicCard;
    expect(describeCard(empty)).toContain('no value in the captured window');
  });
});
