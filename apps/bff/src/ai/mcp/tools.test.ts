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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

const BFF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { buildTools } from '../lib/registry.js';
import { createCaptureContext } from './capture.js';
import { listToolDefs, callTool, CARDS_META_KEY, slimForTransport, clampWindow } from './tools.js';
import { surfaceFor } from './server.js';

const config = { current: configSchema.parse({}) } as ConfigSource;
const deps = { config, subject: { roles: ['admin'] }, offsetMinutes: 0 };
const defs = listToolDefs(deps);
const byName = (n: string): (typeof defs)[number] | undefined => defs.find((d) => d.name === n);
const props = (n: string): string[] => Object.keys((byName(n)?.inputSchema.properties ?? {}) as object);

describe('the MCP tool surface is the shared registry, plus a time window', () => {
  it('exposes every registry tool and nothing else', () => {
    const { ctx } = createCaptureContext({ ...deps, windowMinutes: 60, step: 'MINUTE' });
    expect(defs.map((d) => d.name).sort()).toEqual(buildTools(ctx).map((t) => t.name).sort());
  });

  // An MCP client has no time picker, so the window has to be an argument.
  it('gives data tools windowMinutes and step', () => {
    expect(props('show_widget')).toContain('windowMinutes');
    expect(props('show_widget')).toContain('step');
  });

  /**
   * The advertised bounds have to be the real ones. The caller here is a
   * language model — precisely the caller that sends a plausible number outside
   * the range it was handed — and a bare `> 0` accepted `1e15`, which becomes a
   * start time hundreds of millions of years back and a window OAP cannot
   * answer for. Clamped, not refused: an over-wide window is a reasonable
   * request badly expressed.
   */
  it.each([
    ['above the maximum', 1e15, 43_200],
    ['just above the maximum', 43_201, 43_200],
    ['below the minimum', 0, 1],
    ['negative', -5, 1],
    ['fractional', 90.7, 90],
  ])('holds a %s window to the schema (%p → %p)', (_label, given, want) => {
    expect(clampWindow(given)).toBe(want);
  });

  it.each([['a string', '60'], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['absent', undefined]])(
    'falls back to the default for %s',
    (_label, given) => {
      expect(clampWindow(given)).toBe(60);
    },
  );

  // The playbooks never touch OAP; a time window on them would be a schema lie.
  it('leaves the guidance tools timeless', () => {
    expect(props('get_playbook')).toEqual(['id']);
    expect(props('list_playbooks')).toEqual([]);
  });

  /**
   * The zod schemas are module-level constants the chat path shares. Grafting
   * the window onto them in place would put `windowMinutes` in the assistant's
   * tool definitions too — where there IS a picker, so the model would be
   * offered a parameter that silently does nothing.
   */
  it('does not mutate the schemas the chat assistant shares', () => {
    const { ctx } = createCaptureContext({ ...deps, windowMinutes: 60, step: 'MINUTE' });
    const chat = buildTools(ctx).find((t) => t.name === 'show_widget');
    const live = toJsonSchema(chat!.schema) as { properties: Record<string, unknown> };
    expect(Object.keys(live.properties)).not.toContain('windowMinutes');
  });

  it('drops $schema, which every client would otherwise pay for per request', () => {
    expect(defs.every((d) => !('$schema' in d.inputSchema))).toBe(true);
  });

  it('describes every tool — an unlabelled tool is one no model will pick', () => {
    expect(defs.filter((d) => d.description.length < 20)).toEqual([]);
  });
});

describe('a tool call that cannot run answers, rather than failing the transport', () => {
  it('names an unknown tool', async () => {
    const r = await callTool(deps, 'no_such_tool', {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('no_such_tool');
  });

  // Bad arguments are the model's to correct, so the validation message is
  // returned verbatim instead of being redacted into "internal error".
  it('returns the validation message for bad arguments', async () => {
    const r = await callTool(deps, 'get_playbook', { id: 42 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/schema|expected|id/i);
  });

  // Every data tool checks its own read verb, so a caller with no roles reaches
  // no OAP at all — this is what stops an agent widening its operator's access.
  it('refuses a read the caller has no verb for, without touching OAP', async () => {
    const r = await callTool({ ...deps, subject: { roles: [] } }, 'list_services', { layer: 'GENERAL' });
    expect(r.content[0].text).toMatch(/permission|not allowed|denied/i);
  });
});

describe('cards travel on the host channel, and a slimmed copy on the model one', () => {
  /**
   * The previous version of this asserted `structuredContent` was never set,
   * and proved it with `get_playbook` — a tool that emits no cards, so it held
   * whatever the code did. It now states the real contract: `_meta` carries the
   * full card for the renderer, `structuredContent` a slimmed copy for hosts
   * that strip `_meta`, and spans (98.5% of a trace card) are what gets cut.
   */
  it('carries a tool with no cards on neither channel', async () => {
    const r = await callTool(deps, 'get_playbook', { id: 'latency' });
    expect(r.structuredContent).toBeUndefined();
    expect(r._meta).toBeUndefined();
  });

  it('strips spans from the model-facing copy and leaves the host copy whole', () => {
    const span = { spanId: 1, tags: Array.from({ length: 40 }, (_, i) => `t${i}`) };
    const card = { type: 'traces', spec: { replayData: { traces: [{ traceId: 'a', spans: [span, span] }] } } };
    const slim = slimForTransport([card as never])[0] as unknown as typeof card;
    expect(slim.spec.replayData.traces[0].spans).toBeUndefined();
    // The source card is untouched — the host still gets every span.
    expect(card.spec.replayData.traces[0].spans).toHaveLength(2);
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(card).length);
  });

  // Only trace-shaped cards carry spans; slimming anything else would lose data
  // the widget needs and save nothing.
  it('passes every other card kind through untouched', () => {
    const card = { type: 'topology', spec: { replayData: { nodes: [1, 2, 3] } } };
    expect(slimForTransport([card as never])[0]).toBe(card);
  });

  it('namespaces the _meta key it does use', () => {
    expect(CARDS_META_KEY).toBe('org.apache.skywalking.horizon/cards');
  });

  /**
   * A tool that returns structured output has to SAY what shape it is — a host
   * that validates against the declaration rejects an undeclared payload, and
   * this test previously enforced the omission, so the whole GUI integration
   * could have been turned away by a conforming host.
   *
   * The pairing is what matters, in both directions: every card tool declares
   * one, and no other tool does, because a schema a tool never satisfies is the
   * same defect the other way round.
   */
  it('declares an outputSchema for exactly the tools that return one', () => {
    const declared = defs.filter((d) => d.outputSchema).map((d) => d.name).sort();
    const emitting = defs.filter((d) => d.emitsCard).map((d) => d.name).sort();
    expect(declared).toEqual(emitting);
    expect(declared.length).toBeGreaterThan(0);
  });

  it('describes the channel the cards actually arrive on', async () => {
    const card = defs.find((d) => d.emitsCard)!;
    const props = (card.outputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual([CARDS_META_KEY]);
  });

  // A schema is a contract, so the payload has to satisfy it. Checked against a
  // real call rather than a hand-written fixture.
  it('returns structuredContent matching the shape it declared', async () => {
    const r = await callTool(deps, 'show_hierarchy', { layer: 'GENERAL' });
    if (!r.structuredContent) return; // no OAP in a unit run; the shape below is what matters when there is
    const cards = (r.structuredContent as Record<string, unknown>)[CARDS_META_KEY];
    expect(Array.isArray(cards)).toBe(true);
    for (const c of cards as Array<Record<string, unknown>>) {
      expect(typeof c.type).toBe('string');
      expect(typeof c.n).toBe('number');
    }
  });
});

describe('the presentation section follows what the client says it can draw', () => {
  it('assumes a terminal when nothing is declared', () => {
    expect(surfaceFor(undefined)).toBe('terminal');
    expect(surfaceFor({})).toBe('terminal');
    expect(surfaceFor({ sampling: {}, elicitation: {} })).toBe('terminal');
  });

  it('switches to inline for a client that declares UI support', () => {
    expect(surfaceFor({ ui: {} })).toBe('inline');
    expect(surfaceFor({ experimental: { ui: {} } })).toBe('inline');
  });
});


describe('a host should not have to ask permission for a read', () => {
  /**
   * Without annotations every tool looks potentially destructive, so a host
   * prompts on each call — and an investigation that walks a topology becomes
   * a consent dialog per hop, which is how an operator learns to click
   * through them without reading.
   */
  it('declares every tool read-only and non-destructive', () => {
    for (const d of defs) {
      expect(d.annotations?.readOnlyHint, d.name).toBe(true);
      expect(d.annotations?.destructiveHint, d.name).toBe(false);
    }
  });

  // The data comes from a live OAP that changes between calls, not a fixed
  // corpus — saying otherwise would invite a host to cache an answer.
  it('says the world is open', () => {
    expect(defs.every((d) => d.annotations?.openWorldHint === true)).toBe(true);
  });

  /**
   * The claim above must stay TRUE, not merely declared. Nothing in the tool
   * surface may mutate: propose_profiling states a case and starts nothing.
   */
  it('has no tool whose name suggests it changes anything', () => {
    const mutating = defs.filter((d) => /^(create|start|delete|update|set|enable|disable|run)_/.test(d.name));
    expect(mutating.map((d) => d.name)).toEqual([]);
  });

  /**
   * A permission dialog naming `kb_resolve_scope_drill` asks the operator to
   * approve an identifier. The title falls back to the name, so a new tool
   * without one degrades quietly rather than failing — this is what makes the
   * omission visible.
   */
  it('gives every tool a display title that is not its wire name', () => {
    const untitled = defs.filter((d) => !d.title || d.title === d.name);
    expect(untitled.map((d) => d.name)).toEqual([]);
  });
});

/**
 * The pointer that tells a host to mount the card renderer belongs only on
 * tools that can produce a card. It was on all 28, so a host prefetched a
 * 2.7 MB renderer for the sixteen that draw nothing.
 *
 * Each tool now DECLARES this on itself (`metadata: EMITS_CARD`) rather than
 * appearing in a list kept somewhere else — there is no structural signal to
 * derive it from, since the `visualization` skill holds `list_zipkin_services`,
 * which draws nothing, and `analyze_profiling` draws from `triggers`.
 */
describe('a tool declares whether it draws', () => {
  const drawing = defs.filter((d) => d.emitsCard).map((d) => d.name);
  const textOnly = defs.filter((d) => !d.emitsCard).map((d) => d.name);

  it('splits the surface, with neither side empty', () => {
    expect(drawing.length).toBeGreaterThan(0);
    expect(textOnly.length).toBeGreaterThan(0);
    expect(drawing.length + textOnly.length).toBe(defs.length);
  });

  /** The direction that costs an operator something: a drawing tool that
   *  forgot to declare renders nothing, silently. */
  it('keeps every show_* tool on the drawing side', () => {
    expect(defs.filter((d) => d.name.startsWith('show_') && !d.emitsCard).map((d) => d.name)).toEqual([]);
  });

  /** Both are counter-examples to the obvious heuristics, and both are why the
   *  declaration exists rather than a name prefix or a skill boundary. */
  it('has analyze_profiling drawing and list_zipkin_services not', () => {
    expect(drawing).toContain('analyze_profiling');
    expect(textOnly).toContain('list_zipkin_services');
  });

  it('never marks a knowledge or navigation tool as drawing', () => {
    const wrong = drawing.filter((n) => n.startsWith('kb_') || n.startsWith('list_') || n.startsWith('get_'));
    expect(wrong).toEqual([]);
  });
});

/**
 * The declaration must match what the tool actually does, and a name is no
 * guide: `fetch_pod_logs` and `propose_profiling` both draw, and both shipped
 * undeclared because the earlier guard only checked `show_*`. Their cards
 * would simply never have mounted.
 *
 * This reads the tool sources and flags any implementation that calls
 * `ctx.emit…` without declaring EMITS_CARD. It deliberately does not assert the
 * converse: `show_figure` delegates to a local `render()` helper, so its emit
 * call is not inline, and demanding symmetry would fail on a false negative.
 * The direction that costs an operator something is the one covered.
 */
describe('a tool that emits a card must declare it', () => {
  const FILES = globSync('src/ai/lib/tools/*/tools.ts', { cwd: BFF_ROOT });

  it('finds the tool sources at all', () => {
    expect(FILES.length).toBeGreaterThan(3);
  });

  it('has no tool that emits inline without declaring', () => {
    const undeclared: string[] = [];
    for (const rel of FILES) {
      const src = readFileSync(join(BFF_ROOT, rel), 'utf8');
      for (const m of src.matchAll(/^\s+name: '([a-z_]+)',/gm)) {
        const start = src.lastIndexOf('tool(', m.index);
        if (start < 0) continue;
        const emitsInline = src.slice(start, m.index).includes('ctx.emit');
        const declares = src.slice(m.index).slice(0, 160).includes('metadata: EMITS_CARD');
        if (emitsInline && !declares) undeclared.push(`${m[1]} (${rel})`);
      }
    }
    expect(undeclared, 'these call ctx.emit… but do not declare EMITS_CARD').toEqual([]);
  });
});
