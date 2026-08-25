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
 * Every card kind tells the model how to read it.
 *
 * The model now analyses the RAW payload rather than a summary written for it,
 * which is the right trade — a summary only answers the questions whoever wrote
 * it thought of — but it moves a burden: the rows have to be self-describing,
 * and some of them are not guessable. A metric map keyed by ids defined
 * elsewhere in the same payload, a self-time field beside a total-time one, a
 * Zipkin timestamp in microseconds where the native one is in milliseconds —
 * each is a wrong reading waiting to happen.
 *
 * So a kind added to the union without a note here fails this, rather than
 * reaching a model as undocumented JSON it will interpret confidently.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { cardPrompt } from '../lib/skills/loader.js';
import { buildTools } from '../lib/registry.js';
import { createCaptureContext } from './capture.js';
import { configSchema } from '../../config/schema.js';

const CARD_SRC = new URL('../lib/graphic-card.ts', import.meta.url);

/** The kinds the BFF can emit, read from the union rather than restated. */
function emittedKinds(): string[] {
  const src = readFileSync(CARD_SRC, 'utf8');
  // Only the GraphicCard union — `StreamEvent` below it adds the control events
  // (token / thinking / …), which are not cards and carry no payload.
  const union = /export type GraphicCard =([\s\S]*?);\n/.exec(src)?.[1] ?? '';
  return [...new Set([...union.matchAll(/type: '([a-z-]+)'/g)].map((m) => m[1]))].sort();
}

describe('every card kind the BFF can emit is documented for the model', () => {
  const kinds = emittedKinds();

  it('finds the union, so a rename cannot make this vacuous', () => {
    expect(kinds.length).toBeGreaterThan(10);
  });

  it.each(emittedKinds())('%s has a structure note', (kind) => {
    const note = cardPrompt(kind);
    expect(note.length, `${kind}'s note is too short to say anything`).toBeGreaterThan(80);
  });

  /**
   * Structure, never per-deployment facts. Naming a metric id here would work
   * on the demo and mislead on any layer an operator authored — the same drift
   * the layer-template rule exists to prevent, one level down.
   */
  /**
   * An OAP metric id is lowercase words joined by underscores behind a scope
   * prefix — `service_cpm`, `endpoint_sla`, `k8s_service_pod_status_restarts_total`.
   * Matching the SHAPE catches any of them; the previous list of four bare
   * words could not match one at all, because `\b` finds no boundary beside an
   * underscore, so `\bcpm\b` never fired against `service_cpm`.
   */
  const METRIC_ID = /\b(?:service|endpoint|instance|process|browser_app|meter|k8s_service|kubernetes_service)_[a-z0-9]+(?:_[a-z0-9]+)*\b/;

  it.each(emittedKinds())('%s describes shape rather than naming a metric', (kind) => {
    const found = METRIC_ID.exec(cardPrompt(kind));
    expect(found?.[0], `${kind}'s note names the metric id "${found?.[0]}" — that varies per layer`).toBeUndefined();
  });

  // The guard is only worth having if it fires, and the last one could not.
  it('the metric-id guard actually matches a real id', () => {
    expect(METRIC_ID.test('read the value from service_cpm')).toBe(true);
    expect(METRIC_ID.test('k8s_service_pod_status_restarts_total')).toBe(true);
    // Field paths and camelCase names are not metric ids.
    expect(METRIC_ID.test('data.series[].label and config.nodeMetrics')).toBe(false);
  });

  // Whether a note names the RIGHT trap is a review judgement, and two attempts
  // at asserting it mechanically both produced proxies a note could satisfy
  // without improving — a word-presence check, then a field-path count that the
  // notes started being bent to satisfy. The rule lives in the yaml's header
  // where a reviewer reads it; what is checked here is presence and drift.
  it('has no note for a kind that does not exist', () => {
    expect(() => cardPrompt('not-a-card')).toThrow(/cards\.yaml/);
  });
});

/**
 * Every kind also has a FORM.
 *
 * `cards.yaml` says how to READ a payload; the terminal presentation says what
 * to turn it into — a table, a tree, prose. Horizon draws nothing for a
 * terminal any more, so a kind with no form leaves the agent to invent one,
 * and the inventions are the ASCII charts this replaced.
 */
describe('every card kind has a presentation form for a client with no frame', () => {
  const PRESENTATION = new URL('../lib/skills/presentation.terminal.md', import.meta.url);
  const prose = readFileSync(PRESENTATION, 'utf8').toLowerCase();

  /** What names the kind in the prose — the form is described in English, not
   *  by the wire tag, so a plain substring of the tag would not find it. */
  const NAMED_BY: Record<string, string> = {
    figure: 'time series',
    topology: 'maps are tables',
    deployment: 'maps are tables',
    'instance-topology': 'maps are tables',
    'endpoint-dependency': 'maps are tables',
    'process-topology': 'process',
    profiling: 'profiling',
    traces: 'traces',
    'zipkin-traces': 'zipkin',
    logs: 'logs are lists',
    'browser-errors': 'browser',
    podlogs: 'pod log',
    hierarchy: 'hierarchy',
    proposal: 'propose_profiling',
  };

  it.each(emittedKinds())('%s has a form', (kind) => {
    const needle = NAMED_BY[kind];
    expect(needle, `${kind} is not in NAMED_BY — add it and give it a form`).toBeDefined();
    expect(prose, `${kind} has no presentation form`).toContain(needle);
  });

  // The prompt is token-costed on every request, and a per-kind list is exactly
  // the shape that grows without anyone noticing.
  it('stays short enough to ship on every request', () => {
    expect(prose.split(/\s+/).length).toBeLessThan(1200);
  });
});

/**
 * Every tool is in the tool guide.
 *
 * `skills.md` is what tells the model a tool EXISTS and when to reach for it,
 * and a tool absent from it is a capability nothing will ever use. Adding
 * `show_layer_topology` and leaving the guide alone is exactly how that
 * happens — the tool worked, the schema was right, and no prompt mentioned it.
 *
 * It checks PRESENCE, not quality: a passing cross-reference from another
 * tool's entry satisfies it. That is the honest limit of a mechanical check
 * here, and whether an entry actually explains the tool stays a review
 * judgement — two attempts at asserting more precise shapes produced proxies
 * the prose could satisfy without improving.
 */
describe('every tool the registry exposes is in the tool guide', () => {
  const GUIDE = new URL('../lib/skills/skills.md', import.meta.url);
  const guide = readFileSync(GUIDE, 'utf8');

  it('names each one', () => {
    const { ctx } = createCaptureContext({
      config: { current: configSchema.parse({}) } as never,
      offsetMinutes: 0,
      windowMinutes: 60,
      step: 'MINUTE',
    } as never);
    const missing = buildTools(ctx)
      .map((t) => t.name)
      .filter((n) => !guide.includes(n));
    expect(missing, `not documented in skills.md: ${missing.join(', ')}`).toEqual([]);
  });
});
