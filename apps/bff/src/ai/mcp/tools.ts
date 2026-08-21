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
 * Adapts the shared tool registry to MCP.
 *
 * Two differences from the chat path, both forced by MCP being stateless:
 *
 *  - **The time window is a per-call argument.** The chat route resolves one
 *    window per conversation from the topbar picker; an MCP client has no
 *    picker and no session, so `windowMinutes` + `step` are grafted onto each
 *    tool's schema and a fresh {@link ToolContext} is built per call.
 *  - **Cards come back in the result**, not out-of-band on a stream. `content`
 *    carries the model-readable rendering (see `content.ts`); the cards
 *    themselves ride in `_meta`, which is host-only.
 */

import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { cardPrompt } from '../lib/skills/loader.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { GraphicCard } from '../lib/graphic-card.js';
import { buildTools } from '../lib/registry.js';
import { rcaTools } from '../lib/tools/rca/tools.js';
import { createCaptureContext, type CaptureDeps, type CaptureStep } from './capture.js';
import { emitsCard } from '../lib/graphic-card.js';

export interface McpToolDef {
  name: string;
  title: string;
  /**
   * Declared for, and only for, the tools that return `structuredContent` —
   * the protocol requires a tool that returns structured output to say what
   * shape it is, and a host that validates against the declaration rejects an
   * undeclared one outright. It is deliberately shallow: the fourteen card
   * variants each carry their own widget-specific `spec`, and inlining all of
   * them would put tens of kilobytes into every `tools/list` for no benefit to
   * a caller that hands the payload straight to the renderer.
   */
  outputSchema?: Record<string, unknown>;
  /** Declared by the tool itself — see EMITS_CARD. Only these point a host at
   *  the `ui://` renderer; the rest have nothing for it to mount. */
  emitsCard: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * What a host needs to decide whether to ask permission.
 *
 * Without these every tool looks potentially destructive, so a host prompts on
 * each call — which for an investigation that walks a topology means a consent
 * dialog per hop, and an operator who stops reading them. Horizon's whole tool
 * surface is READ-ONLY: it queries OAP and renders. Even `propose_profiling`
 * only states a case; nothing here starts a task or writes anything, which is
 * a property enforced in the tools themselves, not merely asserted here.
 *
 * `openWorldHint` is true because the answers come from a live OAP whose data
 * changes between calls, not from a fixed corpus.
 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Display names for a host's tool list and permission UI.
 *
 * The wire name is snake_case and prefixed by skill (`kb_`, `show_`), which
 * reads as an identifier rather than an action; a host that shows it verbatim
 * asks the operator to approve `kb_resolve_scope_drill`. These say what the
 * call does in the vocabulary of the screen it came from. A tool absent here
 * falls back to its name, so adding a tool cannot break the listing.
 */
const TOOL_TITLES: Record<string, string> = {
  list_playbooks: 'List root-cause playbooks',
  get_playbook: 'Read a root-cause playbook',
  list_layers: 'List observability layers',
  list_services: 'List services',
  check_horizon_health: 'Check Horizon and OAP health',
  list_alarms: 'List alarms',
  kb_layer_capabilities: 'Describe what a layer offers',
  kb_browse_catalog: 'Browse the metric catalog',
  kb_describe_metric: 'Describe a metric',
  kb_search_metrics: 'Search metrics',
  kb_resolve_scope_drill: 'Resolve a metric scope drill-down',
  kb_resolve_hierarchy: 'Resolve a layer hierarchy',
  list_pod_containers: 'List pod containers',
  fetch_pod_logs: 'Read pod logs',
  show_figure: 'Capture a metric figure',
  show_widget: 'Capture a dashboard widget',
  show_hierarchy: 'Capture the layer hierarchy',
  show_topology: 'Capture one service’s neighbours',
  show_layer_topology: 'Capture the whole layer map',
  show_deployment: 'Capture the deployment view',
  show_instance_topology: 'Capture the instance topology',
  show_endpoint_dependency: 'Capture endpoint dependencies',
  show_traces: 'Read traces',
  list_zipkin_services: 'List Zipkin services',
  show_zipkin_traces: 'Read Zipkin traces',
  show_logs: 'Read logs',
  show_browser_logs: 'Read browser errors',
  propose_profiling: 'Propose a profiling task (starts nothing)',
  analyze_profiling: 'Analyze a completed profiling task',
};

const DEFAULT_WINDOW_MIN = 60;
/** Matches the schema's own `maximum` — 30 days. Kept beside it so the two
 *  cannot drift, since the point is that the advertised bound is the real one. */
const MAX_WINDOW_MIN = 43_200;

/** The window a caller asked for, held to the range the schema promises. */
export function clampWindow(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_WINDOW_MIN;
  return Math.min(Math.max(Math.floor(raw), 1), MAX_WINDOW_MIN);
}

const STEPS: CaptureStep[] = ['MINUTE', 'HOUR', 'DAY'];

const WINDOW_PROPS: Record<string, unknown> = {
  windowMinutes: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_WINDOW_MIN,
    description:
      'How far back to read, in minutes, ending now. Defaults to 60. Widen it to see a trend, ' +
      'narrow it to isolate an incident.',
  },
  step: {
    type: 'string',
    enum: STEPS,
    description:
      'Bucket precision: MINUTE (default, up to about a day), HOUR (multi-day), DAY (weeks). ' +
      'Reading a week at MINUTE precision is refused by OAP — widen the step with the window.',
  },
};

/**
 * Tools that must NOT be given the shared `windowMinutes` / `step` properties.
 *
 * rca tools are pure guidance and never read OAP, so a window on them would be
 * a schema lie — derived from the registry rather than hand-kept.
 *
 * The Kubernetes pod tools are the other case, and a worse one: they take their
 * own `windowSeconds` and ignore anything else, so advertising `windowMinutes`
 * invited a caller to ask for 60 minutes, had it silently stripped, and served
 * the five-minute default. A parameter a tool ignores is worse than one it does
 * not offer, because the answer looks like the one that was asked for.
 */
const TIMELESS = new Set([
  ...rcaTools().map((t) => t.name),
  'fetch_pod_logs',
  'list_pod_containers',
]);

/**
 * The zod schemas are module-level constants shared with the chat path, so the
 * window properties are merged into a COPY of the converted JSON Schema. The
 * conversion is also memoised: a client's prompt cache keys on the byte content
 * of the tool list, and re-converting per request risks key-order drift.
 */
let defsCache: McpToolDef[] | null = null;

function withWindow(name: string, schema: Record<string, unknown>): Record<string, unknown> {
  if (TIMELESS.has(name)) return schema;
  const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
  return { ...schema, properties: { ...props, ...WINDOW_PROPS } };
}

function toolSchema(tool: StructuredToolInterface): Record<string, unknown> {
  const json = toJsonSchema(tool.schema) as Record<string, unknown>;
  // `$schema` is meaningful to a validator but noise in every tool listing —
  // and it is bytes the client pays for on every request.
  const { $schema: _drop, ...rest } = json;
  return withWindow(tool.name, rest);
}

/** Tool metadata does not depend on the context the tools close over, so the
 *  listing is built from a throwaway one and cached. */
export function listToolDefs(deps: Omit<CaptureDeps, 'windowMinutes' | 'step'>): McpToolDef[] {
  if (defsCache) return defsCache;
  const { ctx } = createCaptureContext({ ...deps, windowMinutes: DEFAULT_WINDOW_MIN, step: 'MINUTE' });
  defsCache = buildTools(ctx).map((t) => ({
    name: t.name,
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema: toolSchema(t),
    title: TOOL_TITLES[t.name] ?? t.name,
    emitsCard: emitsCard(t),
    // Declared on every tool, because every tool returns structured output.
    // A tool that emits no card returns none, and declaring a schema it never
    // satisfies is the same defect in the other direction.
    // A tool declaring an output schema MUST return structured content matching
    // it, so the two go on together or not at all.
    outputSchema: PAYLOAD_OUTPUT_SCHEMA,
    annotations: { ...READ_ONLY_ANNOTATIONS, title: TOOL_TITLES[t.name] ?? t.name },
  }));
  return defsCache;
}

/**
 * Where the cards ride: ONE copy, in `structuredContent`.
 *
 * They used to ride twice — the full payload in `_meta`, a span-stripped copy
 * in `structuredContent` — on the reasoning that `_meta` is the channel for
 * data a HOST consumes and a model does not, so the model should not pay for a
 * captured trace list.
 *
 * Two things are wrong with it. `_meta` is the LESS reliable channel, not the
 * more: it is defined as implementation metadata, and whether a client passes
 * it to an agent is up to the client — so the good copy was the one most likely
 * to be dropped, and a host that dropped it silently lost every span waterfall
 * while the trace LIST still rendered, which looks like working software. And
 * two fidelities of one payload means the answer to "what did we capture"
 * depends on which field you read.
 *
 * So: one copy, in the field every client forwards, read by the model AND by
 * whichever renderer the client has. The model analyses the raw payload — that
 * is what it is for — and the size control is the CAPTURE CAP, which is the
 * honest place for it. A payload too large for a context is a cap to lower, not
 * a second fidelity to invent.
 *
 * The `outputSchema` declares the envelope so a validating host accepts it, and
 * stops there rather than enumerating all fourteen `spec` variants: that would
 * add tens of kilobytes to every tools/list, paid by every client including the
 * many that will never draw one, to describe a payload the renderer already
 * understands.
 */
/**
 * The ONE key a reply's payload rides under, whatever kind it is.
 *
 * FLAT: `{ tool, kind?, capturedAt?, data }`. There is no array and no card
 * envelope — a tool call captures exactly one thing, and the wrapper it used to
 * arrive in is the chat panel's, where several blocks stream into one turn and
 * each needs a position. Over MCP that position was always 1, so it was both
 * unused by the terminal and WRONG for a host drawing several: every block came
 * out labelled the same. A client that shows more than one knows their order —
 * it is the only thing that does — so it numbers them itself.
 *
 * `kind` says which block the data is, for the one tool whose shape varies with
 * its arguments. Absent means plain rows, in the shape that tool's description
 * gives.
 *
 * `{ tool, kind?, capturedAt?, spec?, data }` — one key, one shape, whatever the
 * tool answered with. `spec` describes the readings and `data` is them; `kind`
 * names the block, and is absent when the tool answered with plain rows.
 */
export const PAYLOAD_KEY = 'org.apache.skywalking.horizon/payload';


/**
 * Where a tool that answers with DATA rather than a card puts its rows.
 *
 * Half the surface does. Those tools used to `JSON.stringify` their payload into
 * `content` and stop there, which left the model parsing JSON out of prose and
 * the renderer unable to find the rows at all — an agent had to hand-wrap them
 * before anything could draw them. Same envelope as a card reply, different key,
 * so one place is read for both.
 */

/**
 * The envelope a data tool's rows travel in.
 *
 * Deliberately not a schema PER TOOL: fourteen of them would add tens of
 * kilobytes to every tools/list, paid by every client, to describe payloads the
 * tool's own description already names. `rows` is left open — it is whatever
 * that tool answers with.
 */
/**
 * The one envelope every card reply publishes.
 *
 * Pure, and exported, so the contract can be checked without an OAP behind it:
 * built inline it could only be asserted against its own schema, and a test
 * that reads the schema passes just as happily when the field stops being
 * written.
 */
export function cardEnvelope(
  tool: string,
  card: GraphicCard & { capturedAt?: number },
  offsetMinutes: number | undefined,
  layerArg: unknown,
): Record<string, unknown> {
  return {
    tool,
    kind: card.type,
    capturedAt: card.capturedAt,
    // Every instant in the payload is the OAP SERVER's, and a reader is
    // routinely in another zone. Without this an agent reads UTC while the
    // notes say "OAP-server local" — a wrong time, stated confidently.
    offsetMinutes,
    // Which layer was read. A model that made the call knows it from its own
    // arguments, but a payload read back cold — replayed, or handed on — does
    // not, and the same metric id means different things under a different
    // layer.
    //
    // The CARD's layer wins over the argument. Tools uppercase before they
    // query, so echoing the argument verbatim made the envelope say "general"
    // while `spec.layer` in the same object said "GENERAL" — two captures of
    // one layer that do not compare equal.
    layer: cardLayer(card) ?? (typeof layerArg === 'string' ? layerArg.toUpperCase() : undefined),
    ...splitCard(card),
  };
}

/** The layer a card says it was read from — the normalised key, not the caller's spelling. */
function cardLayer(card: GraphicCard): string | undefined {
  const layer = (card as { spec?: { layer?: unknown } }).spec?.layer;
  return typeof layer === 'string' && layer ? layer : undefined;
}

const PAYLOAD_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    [PAYLOAD_KEY]: {
      type: 'object',
      description: 'What this call produced: the data it read, and what that data is.',
      properties: {
        tool: { type: 'string', description: 'The tool that produced this payload.' },
        kind: {
          type: 'string',
          description:
            'Which block this is — `content` explains how to read that kind. Absent when the tool answered with plain rows.',
        },
        capturedAt: { type: 'integer', description: 'Epoch milliseconds the readings were taken.' },
        layer: { type: 'string', description: 'The layer the readings were taken from.' },
        offsetMinutes: {
          type: 'integer',
          description:
            "The OAP server's UTC offset in minutes. Every instant in this payload is in it — render times against this, not against the reader's clock.",
        },
        spec: {
          description:
            'What was asked for and what it means: title, scope, unit, the MQE expression, the tip explaining the metric. Describes the readings; is not itself a reading.',
        },
        data: { description: 'The readings. A self-contained snapshot, drawn with no further calls.' },
      },
      // `data` is NOT required: a proposal is entirely a description of an
      // action nobody has taken, so it carries no readings. Fabricating an
      // empty one to satisfy the declaration would invent a measurement.
      required: ['tool'],
      additionalProperties: false,
    },
  },
  required: [PAYLOAD_KEY],
  additionalProperties: false,
};



/**
 * A tool that answered with data rather than a card.
 *
 * Its reply is one of two things, and the fork is the parse: rows, or a
 * deliberate sentence. Several of those sentences are the most important thing
 * their tool can say — "Permission denied…", "No alarms in the recent window —
 * nothing is firing." — so prose stays prose, in `content`, and gets no
 * structured envelope it would only distort.
 */
function dataResult(tool: string, text: string): McpToolResult {
  /**
   * Prose rides in the envelope too, as a string `data`.
   *
   * Every tool declares an output schema, and MCP requires a tool that declares
   * one to RETURN structured content — the reference client throws
   * `InvalidRequest` otherwise. Returning a bare sentence therefore turned the
   * answers that matter most ("Permission denied…", "No alarms in the recent
   * window — nothing is firing.") into transport errors on any SDK-built
   * client. The sentence is unchanged in `content`; the envelope simply carries
   * it as well, and both renderers already print a string `data` verbatim.
   */
  const prose = (): McpToolResult => ({
    content: [{ type: 'text', text }],
    structuredContent: { [PAYLOAD_KEY]: { tool, data: text } },
  });
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    return prose();
  }
  // A bare string or number that happens to be valid JSON is still prose.
  if (rows === null || typeof rows !== 'object') return prose();
  return {
    content: [
      {
        type: 'text',
        text: `${tool} returned rows — they are in this result's structuredContent under "${PAYLOAD_KEY}" as \`data\`. Read them for the analysis, and render them for the operator.`,
      },
    ],
    structuredContent: { [PAYLOAD_KEY]: { tool, data: rows } },
  };
}

/**
 * Which field of a kind's content holds the READINGS.
 *
 * The rest of that content describes them — what was asked for, in what unit,
 * measured by which expression — and the two are worth telling apart, because
 * only one of them changes when you run the same query again.
 *
 * The field NAME differs per kind because the payloads genuinely do; the split
 * does not. A kind absent from here carries no readings at all: a proposal is
 * entirely a description of an action nobody has taken.
 */
const READINGS_FIELD: Record<string, string> = {
  figure: 'result',
  profiling: 'trees',
  podlogs: 'initialLines',
  topology: 'replayData',
  deployment: 'replayData',
  'instance-topology': 'replayData',
  'endpoint-dependency': 'replayData',
  'process-topology': 'replayData',
  hierarchy: 'replayData',
  traces: 'replayData',
  'zipkin-traces': 'replayData',
  logs: 'replayData',
  'browser-errors': 'replayData',
};

/**
 * A card split into what it IS and what was READ.
 *
 * `spec` describes — title, scope, unit, the MQE, the tip explaining what the
 * metric means. `data` is the readings. A figure already came this way (`spec`
 * beside `result`); the other thirteen had both in one bag, so a reader could
 * not tell the query from its answer without knowing which field was which.
 */
function splitCard(card: GraphicCard & { capturedAt?: number }): { spec: unknown; data: unknown } {
  if (card.type === 'figure') {
    // A figure's description is the widget itself, and it is one level down.
    const figure = card.figures[0];
    return {
      // The widget's own title wins over the card's: the card's is a group
      // label, the widget's names the metric.
      spec: { layout: card.layout, ...(card.title ? { groupTitle: card.title } : {}), ...figure?.spec, xaxis: figure?.xaxis },
      data: figure?.result,
    };
  }
  const field = READINGS_FIELD[card.type];
  const content = (card as unknown as { spec: Record<string, unknown> }).spec ?? {};
  if (!field) return { spec: content, data: undefined };
  const { [field]: data, ...spec } = content;
  return { spec, data };
}

/**
 * The one line that tells a reader the payload is there and what to do with it.
 *
 * Named counts rather than a total, because "3 blocks" does not say whether the
 * trace list arrived. Kept to one line: this is orientation, not a summary.
 */
function whereTheDataIs(tool: string, cards: GraphicCard[]): string {
  const byKind = new Map<string, number>();
  for (const c of cards) byKind.set(c.type, (byKind.get(c.type) ?? 0) + 1);
  const listed = [...byKind].map(([kind, n]) => (n > 1 ? `${n}× ${kind}` : kind)).join(', ');
  const lines = [
    // What is here and where. WHICH renderer to use is appended by the server,
    // which is the layer that knows their addresses.
    `${tool} captured ${listed}. The payload is in this result's structuredContent under ` +
      `"${PAYLOAD_KEY}" as \`data\` — read it for the analysis, and present it to the operator yourself.`,
    '',
    // How to read each kind, for the kinds actually present. The model gets the
    // raw rows, so it needs to know what they MEAN — a keyed metric map whose
    // keys are defined elsewhere in the same payload is not guessable, and a
    // guess about which field is self time is a wrong diagnosis.
    ...[...byKind.keys()].map((kind) => `${kind}: ${cardPrompt(kind)}`),
  ];
  return lines.join('\n');
}

/** Shaped to the SDK's `CallToolResult`; the index signature is what makes it
 *  assignable to the protocol's open result type. */
export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export async function callTool(
  deps: Omit<CaptureDeps, 'windowMinutes' | 'step'>,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const { windowMinutes, step, ...toolArgs } = args;
  const run = createCaptureContext({
    ...deps,
    // Enforce the bounds the schema ADVERTISES. A caller is a language model,
    // which is exactly the kind of caller that sends a plausible-looking value
    // outside the range it was given — and `> 0` accepted 1e15, which becomes a
    // start time hundreds of millions of years ago and a window OAP cannot
    // answer for. Clamped rather than refused, because a slightly-too-wide
    // window is a reasonable request badly expressed, not an error worth
    // failing a whole conversation over.
    windowMinutes: clampWindow(windowMinutes),
    step: STEPS.includes(step as CaptureStep) ? (step as CaptureStep) : 'MINUTE',
  });

  const tool = buildTools(run.ctx).find((t) => t.name === name);
  if (!tool) {
    return { content: [{ type: 'text', text: `No tool named "${name}".` }], isError: true };
  }

  let text: string;
  try {
    const out = await tool.invoke(toolArgs);
    text = typeof out === 'string' ? out : JSON.stringify(out);
  } catch (err) {
    // The message is the tool's own (bad arguments, an OAP error already
    // wrapped by client/) — an agent can act on it, so it is not redacted the
    // way the chat route redacts provider internals.
    return {
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }

  // Stamp the capture instant HERE. On the chat path the UI stamps it as it
  // turns a stream event into a block; MCP has no such step — the card goes
  // straight from here to the host — so without this every rendered card shows
  // "captured" with no time, on the one badge whose whole job is saying that
  // this is a snapshot rather than live data.
  const capturedAt = Date.now();
  // The `in` narrowing types an existing `capturedAt` as `unknown`, so it is
  // read explicitly rather than relied on to survive the spread.
  const cards: Array<GraphicCard & { capturedAt?: number }> = run.finish().map((c) => {
    const already = (c as { capturedAt?: number }).capturedAt;
    return { ...c, capturedAt: already ?? capturedAt };
  });
  if (cards.length === 0) return dataResult(name, text);

  // `content` says what was captured and where it is; the DATA is next door.
  // It deliberately does not summarise the payload — a digest is a third
  // representation of one capture, and it answers only the questions whoever
  // wrote it thought of. The model reads the rows.
  return {
    content: [{ type: 'text', text: `${text}\n\n${whereTheDataIs(name, cards)}` }],
    // Flat: the block's own payload, its kind, and when it was read. The card
    // envelope around it is the chat panel's, and its `n` was always 1 here.
    structuredContent: { [PAYLOAD_KEY]: cardEnvelope(name, cards[0], deps.offsetMinutes, args.layer) },
  };
}
