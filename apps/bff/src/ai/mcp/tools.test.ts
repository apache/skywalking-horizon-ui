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
import { listToolDefs, callTool, PAYLOAD_KEY, clampWindow, cardEnvelope } from './tools.js';
import { surfaceFor } from './server.js';

const config = { current: configSchema.parse({}) } as ConfigSource;
const deps = { config, subject: { roles: ['admin'] }, offsetMinutes: 0 };
const defs = listToolDefs(deps);
const byName = (n: string): (typeof defs)[number] | undefined => defs.find((d) => d.name === n);
const props = (n: string): string[] => Object.keys((byName(n)?.inputSchema.properties ?? {}) as object);

describe('the MCP tool surface is the shared registry, plus a time window', () => {
  /**
   * The registry is the single tool list, so CAPABILITY cannot diverge between
   * the chat panel and MCP. Nothing MCP-only belongs here — not even a
   * presentation helper, since Horizon draws for no client that cannot draw for
   * itself.
   */
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

describe('the capture travels once, on the channel every client forwards', () => {
  /**
   * It used to ride twice — full in `_meta`, span-stripped in
   * `structuredContent`. That put the GOOD copy on the LESS reliable channel:
   * `_meta` is implementation metadata and a client need not pass it on, so a
   * host that dropped it lost every span waterfall while the trace list still
   * rendered — which looks like working software.
   */
  /**
   * Every tool declares an output schema, and MCP requires a tool that declares
   * one to RETURN structured content — the reference client throws
   * `InvalidRequest` otherwise. So there is no such thing here as a reply with
   * no envelope; a prose answer carries its sentence as a string `data`.
   */
  it('carries an envelope even for a tool that emits no cards', async () => {
    const r = await callTool(deps, 'get_playbook', { id: 'latency' });
    const envelope = (r.structuredContent as Record<string, { tool: string; data: unknown }>)[PAYLOAD_KEY];
    expect(envelope.tool).toBe('get_playbook');
    expect(typeof envelope.data).toBe('string');
    expect(r._meta).toBeUndefined();
  });

  it('namespaces the key it does use', () => {
    expect(PAYLOAD_KEY).toBe('org.apache.skywalking.horizon/payload');
  });

  /**
   * A tool that returns structured output has to SAY what shape it is — a host
   * that validates against the declaration rejects an undeclared payload.
   *
   * EVERY tool declares one now. Half of them answer with rows rather than a
   * card, and those used to stringify the rows into `content` and stop, which
   * left the model parsing JSON out of prose and the renderer unable to find
   * them at all.
   */
  it('declares an outputSchema for every tool', () => {
    const undeclared = defs.filter((d) => !d.outputSchema).map((d) => d.name);
    expect(undeclared).toEqual([]);
    expect(defs.length).toBeGreaterThan(20);
  });

  /**
   * ONE key and ONE shape for both kinds. There were two, and the shapes
   * differed — an array under one, a labelled object under the other — which is
   * two structures for one idea, learnt twice and misread once.
   */
  it('declares one envelope, the same for every tool', () => {
    const keyOf = (d: (typeof defs)[number]): string[] =>
      Object.keys((d.outputSchema as { properties: Record<string, unknown> }).properties);
    expect(keyOf(defs.find((d) => d.emitsCard)!)).toEqual([PAYLOAD_KEY]);
    expect(keyOf(defs.find((d) => !d.emitsCard)!)).toEqual([PAYLOAD_KEY]);
  });


  /**
   * A tool answering with rows now puts them where the model and the renderer
   * both look, instead of stringifying them into prose.
   */
  it('carries a data tool’s rows in the same envelope a card tool uses', async () => {
    const r = await callTool(deps, 'list_playbooks', {});
    const envelope = (r.structuredContent as Record<string, { tool: string; data: unknown; kind?: string }>)?.[
      PAYLOAD_KEY
    ];
    expect(envelope?.tool).toBe('list_playbooks');
    expect(Array.isArray(envelope?.data)).toBe(true);
    // No `kind`: a tool answering with plain rows has no block to name, and the
    // tool name is what says how to read them.
    expect(envelope?.kind).toBeUndefined();
  });

  /**
   * Prose stays PROSE — unchanged, not tabulated. It rides in `data` as the
   * string it is, so a client that validates the declared schema accepts the
   * reply and a renderer prints the sentence verbatim.
   */
  it('keeps a prose answer intact in both channels', async () => {
    const r = await callTool(deps, 'get_playbook', { id: 'latency' });
    const envelope = (r.structuredContent as Record<string, { data: unknown }>)[PAYLOAD_KEY];
    expect(envelope.data).toBe(r.content[0].text);
    expect(r.content[0].text.length).toBeGreaterThan(20);
  });

  // A schema is a contract, so the payload has to satisfy it. Checked against a
  // real call rather than a hand-written fixture.
  /**
   * The earlier version of this called `show_hierarchy`, returned early when
   * there was no OAP, and then asserted the PRE-SPLIT shape — so it could not
   * fail on any machine, and would not have caught the split if it had run.
   * A tool that needs no backend proves the same contract.
   */
  it('returns structuredContent matching the shape it declared', async () => {
    const r = await callTool(deps, 'list_playbooks', {});
    const envelope = (r.structuredContent as Record<string, Record<string, unknown>>)[PAYLOAD_KEY];
    expect(envelope).toBeDefined();
    expect(envelope.tool).toBe('list_playbooks');
    expect(Array.isArray(envelope.data)).toBe(true);
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

describe('every reply satisfies the schema its own tool declares', () => {
  /**
   * The check that was missing, and the reason two protocol breaks got past a
   * live smoke test: raw curl accepts anything, while an SDK-built client
   * validates `structuredContent` against the declared `outputSchema` and
   * REFUSES the reply on a mismatch. A prose answer with no envelope, and a
   * proposal with no `data`, were each rejected outright — turning the
   * sentences that matter most, and one whole tool, into transport errors.
   *
   * The two rules the SDK enforces and that both breaks violated: a declared
   * schema means structured content MUST be returned, and the payload must
   * satisfy `required` without adding a property `additionalProperties: false`
   * forbids. Checked directly rather than through a JSON-schema library, which
   * is a transitive dependency here and not one this package declares.
   */
  const envelopeSchema = (name: string): { required: string[]; properties: Record<string, unknown> } => {
    const schema = listToolDefs(deps).find((d) => d.name === name)?.outputSchema as {
      properties: Record<string, { required: string[]; properties: Record<string, unknown> }>;
    };
    return schema.properties[PAYLOAD_KEY];
  };

  const breaks = (payload: Record<string, unknown>, name: string): string[] => {
    const { required, properties } = envelopeSchema(name);
    return [
      ...required.filter((k) => payload[k] === undefined).map((k) => `missing required "${k}"`),
      ...Object.keys(payload).filter((k) => !(k in properties)).map((k) => `undeclared "${k}"`),
    ];
  };

  it.each([
    ['get_playbook', { id: 'latency' }],
    ['list_playbooks', {}],
    ['list_alarms', {}],
  ])('%s returns structured content matching its declaration', async (name, args) => {
    expect(listToolDefs(deps).find((d) => d.name === name)?.outputSchema).toBeDefined();
    const r = await callTool(deps, name, args as Record<string, unknown>);
    expect(r.structuredContent, `${name} declared a schema and returned nothing`).toBeDefined();
    const payload = (r.structuredContent as Record<string, Record<string, unknown>>)[PAYLOAD_KEY];
    expect(payload, `${name} used a key its schema does not declare`).toBeDefined();
    expect(breaks(payload, name)).toEqual([]);
  });

  /**
   * A proposal carries no readings — nothing has run — so `data` is genuinely
   * absent. The schema marked it required, which made the whole tool unusable
   * on a validating client.
   */
  it('accepts a payload with no readings at all', () => {
    const proposal = { tool: 'propose_profiling', kind: 'proposal', capturedAt: 1, spec: { cause: 'c' } };
    expect(breaks(proposal, 'propose_profiling')).toEqual([]);
  });
});

describe('the wire contract, which 1.0.0 freezes', () => {
  /**
   * Horizon has not released, so this branch could reshape the envelope freely
   * — and did, several times. From 1.0.0 it is a published API: agents are
   * configured against it, saved renderers are addressed by content hash, and a
   * field that quietly changes meaning breaks a client nobody here can see.
   *
   * This is not a schema test — `outputSchema` is checked above. It is a
   * TRIPWIRE. Changing the envelope means editing this list, which turns a
   * rename or a dropped field into a deliberate act with a reviewer attached,
   * rather than a diff that happens to still compile.
   */
  const ENVELOPE = ['tool', 'kind', 'capturedAt', 'offsetMinutes', 'layer', 'spec', 'data'] as const;

  it('names exactly the keys 1.0.0 publishes', () => {
    const schema = listToolDefs(deps).find((d) => d.emitsCard)?.outputSchema as {
      properties: Record<string, { properties: Record<string, unknown>; required: string[] }>;
    };
    const envelope = schema.properties[PAYLOAD_KEY];
    expect(Object.keys(envelope.properties).sort()).toEqual([...ENVELOPE].sort());
    // `tool` alone is mandatory: a proposal carries no readings, and every
    // other field is absent in some legitimate reply.
    expect(envelope.required).toEqual(['tool']);
  });

  /**
   * Without it the renderer drew UTC while six mappers labelled the output
   * "OAP-server local" — a wrong time, stated confidently, on a server in any
   * zone but UTC. Nothing wrote the field; nothing noticed.
   */
  it('carries the OAP offset, which every instant in the payload is in', () => {
    const card = { type: 'hierarchy', n: 1, capturedAt: 7, spec: { layer: 'GENERAL' } } as never;
    expect(cardEnvelope('show_hierarchy', card, 480, 'GENERAL')).toMatchObject({ offsetMinutes: 480 });
  });

  /**
   * The envelope names the NORMALISED layer. Echoing the caller's spelling made
   * it say "general" while `spec.layer` in the same object said "GENERAL", so
   * two captures of one layer did not compare equal.
   */
  it('normalises the layer, and prefers what the card itself says', () => {
    const card = { type: 'hierarchy', n: 1, spec: { layer: 'GENERAL' } } as never;
    expect(cardEnvelope('show_hierarchy', card, 0, 'general')).toMatchObject({ layer: 'GENERAL' });
    const noLayer = { type: 'figure', n: 1, figures: [] } as never;
    expect(cardEnvelope('show_figure', noLayer, 0, 'mesh')).toMatchObject({ layer: 'MESH' });
  });

  it('publishes one key, under the project’s own namespace', () => {
    expect(PAYLOAD_KEY).toBe('org.apache.skywalking.horizon/payload');
    const keys = new Set(
      listToolDefs(deps)
        // The presentation tool returns text and declares no schema; every tool
        // that DOES declare one must publish this key and no other.
        .filter((d) => d.outputSchema)
        .flatMap((d) => Object.keys((d.outputSchema as { properties: Record<string, unknown> }).properties)),
    );
    expect([...keys]).toEqual([PAYLOAD_KEY]);
  });

  /**
   * The card address is part of the contract: a host saves it against its hash
   * and reuses it for a conversation, so the SCHEME may not drift even if the
   * hash does.
   */
  it('keeps the card address scheme', async () => {
    const { mcpAppBundle } = await import('./resource.js');
    const uri = mcpAppBundle()?.uri;
    if (uri) expect(uri).toMatch(/^ui:\/\/horizon\/app\/[0-9a-f]{12}$/);
  });
});
