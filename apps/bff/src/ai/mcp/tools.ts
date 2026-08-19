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
import type { StructuredToolInterface } from '@langchain/core/tools';
import { buildTools } from '../lib/registry.js';
import { rcaTools } from '../lib/tools/rca/tools.js';
import type { GraphicCard } from '../lib/graphic-card.js';
import { createCaptureContext, type CaptureDeps, type CaptureStep } from './capture.js';
import { describeCard } from './content.js';
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
  show_figure: 'Draw a metric figure',
  show_widget: 'Draw a dashboard widget',
  show_hierarchy: 'Draw the layer hierarchy',
  show_topology: 'Draw the service topology',
  show_deployment: 'Draw the deployment view',
  show_instance_topology: 'Draw the instance topology',
  show_endpoint_dependency: 'Draw endpoint dependencies',
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
    // Declared where, and only where, structured output is actually returned.
    // A tool that emits no card returns none, and declaring a schema it never
    // satisfies is the same defect in the other direction.
    ...(emitsCard(t) ? { outputSchema: CARD_OUTPUT_SCHEMA } : {}),
    annotations: { ...READ_ONLY_ANNOTATIONS, title: TOOL_TITLES[t.name] ?? t.name },
  }));
  return defsCache;
}

/**
 * Where the cards ride, and why it is `_meta` rather than `structuredContent`.
 *
 * `structuredContent` is MODEL-facing — a host is expected to put it in the
 * model's context, which is the whole point of having it. A captured trace list
 * is around 550 KB (30 traces, spans inline, because that is what makes the
 * waterfall replay offline); handing that to a model costs six figures of
 * tokens to say what `content` already says in three. `_meta` is the channel
 * defined for data the HOST consumes and the model does not, which is exactly
 * what a card is: a payload for a renderer.
 *
 * A card-producing tool therefore DOES return structured output, and declares
 * an `outputSchema` for it — a host that validates against the declaration
 * rejects an undeclared payload. The schema stops at the card envelope rather
 * than enumerating all fourteen `spec` variants: that would add tens of
 * kilobytes to every tools/list, paid by every client including the many that
 * will never draw one, to describe a payload the renderer already understands.
 */
export const CARDS_META_KEY = 'org.apache.skywalking.horizon/cards';

/** The shape of `structuredContent` for a card-producing tool. */
const CARD_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    [CARDS_META_KEY]: {
      type: 'array',
      description:
        'Rendered cards for this answer. Each is a self-contained snapshot — a host can draw it ' +
        'with no further calls. The ui:// resource renders them; the text content says the same ' +
        'thing in prose for a host that cannot.',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Which widget draws this card.',
          },
          n: { type: 'integer', description: 'Position of the card within this answer, from 1.' },
          capturedAt: { type: 'integer', description: 'Epoch milliseconds the data was read at.' },
        },
        required: ['type', 'n'],
        additionalProperties: true,
      },
    },
  },
  required: [CARDS_META_KEY],
  additionalProperties: false,
};

/**
 * The same cards, minus the one field that dominates their weight.
 *
 * `_meta` is where the spec puts widget-only data, and it carries the full
 * payload. But OpenAI hosts have a known defect stripping `_meta`, and their
 * own guidance is not to depend on it alone — so a portable copy also rides in
 * `structuredContent`, which every host forwards.
 *
 * `structuredContent` is model-facing though, and a captured trace list is
 * 582 KB. Measured, the spans are 98.5% of that: dropping them leaves 8.4 KB,
 * and the trace LIST renders identically without them — only the span
 * waterfall needs them, and a host that strips `_meta` was never going to
 * offer that anyway. So the portable copy is a real card with one capability
 * removed, not a stub, and the widget prefers the `_meta` original wherever it
 * survives.
 */
export function slimForTransport(cards: GraphicCard[]): GraphicCard[] {
  return cards.map((card) => {
    if (card.type !== 'traces' && card.type !== 'zipkin-traces') return card;
    const spec = card.spec as { replayData?: Record<string, unknown> };
    if (!spec?.replayData) return card;
    const strip = (rows: unknown): unknown =>
      Array.isArray(rows) ? rows.map((r) => ({ ...(r as object), spans: undefined })) : rows;
    const rd = spec.replayData as { traces?: unknown; native?: { traces?: unknown } };
    return {
      ...card,
      spec: {
        ...spec,
        replayData: {
          ...rd,
          ...(rd.traces ? { traces: strip(rd.traces) } : {}),
          ...(rd.native ? { native: { ...rd.native, traces: strip(rd.native.traces) } } : {}),
        },
      },
    } as GraphicCard;
  });
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
  const cards = run.finish().map((c) => ('capturedAt' in c && c.capturedAt ? c : { ...c, capturedAt }));
  if (cards.length === 0) return { content: [{ type: 'text', text }] };

  // A card describes itself only when it holds something the tool's own reply
  // does not already carry — see `describeCard`.
  const rendered = cards.map((c) => describeCard(c, deps.offsetMinutes)).filter((s): s is string => s !== null);
  return {
    content: [{ type: 'text', text: rendered.length ? `${text}\n\n${rendered.join('\n\n')}` : text }],
    // Both channels: the full payload where the spec says widget-only data
    // belongs, and a slimmed portable copy for hosts that drop it.
    _meta: { [CARDS_META_KEY]: cards },
    structuredContent: { [CARDS_META_KEY]: slimForTransport(cards) },
  };
}
