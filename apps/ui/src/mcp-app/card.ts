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
 * A BFF `GraphicCard` as the transcript `Block` the chat components take.
 *
 * The two shapes are almost the same — the card says `type` where the block
 * says `kind`, and the figure card carries its layout differently. Keeping the
 * translation here rather than changing either side is deliberate: the wire
 * shape belongs to the BFF and the block shape to the panel, and this bundle is
 * a third consumer that should not get to redefine either.
 */

import type { Block } from '@/ai/types';

/** The wire card. Structurally the BFF's `GraphicCard`, restated because this
 *  bundle must not import from the BFF — it builds standalone. */
export interface GraphicCard {
  type: string;
  n: number;
  title?: string;
  layout?: string;
  figures?: unknown[];
  spec?: unknown;
  capturedAt?: number;
  status?: string;
}

/**
 * A card as the block its component expects.
 *
 * `n` is supplied by the CALLER, from its own ordering. The server used to send
 * one, but its counter restarts per tool call, so over MCP every block arrived
 * as 1 and a conversation showing several labelled them all the same. The side
 * accumulating them is the only one that knows their order.
 */
export function toBlock(card: GraphicCard, n: number): Block {
  if (card.type === 'figure') {
    return {
      kind: 'figure',
      n,
      title: card.title,
      layout: (card.layout ?? 'single') as never,
      figures: (card.figures ?? []) as never,
      capturedAt: card.capturedAt,
    } as Block;
  }
  if (card.type === 'proposal') {
    // A proposal in a host has no approve path — nothing here can call the
    // verb-gated create route — so it mounts in its terminal state and reads
    // as the decision card it is. The operator acts in Horizon.
    return { kind: 'proposal', n, spec: card.spec, status: 'proposed' } as Block;
  }
  return {
    kind: card.type,
    n,
    spec: card.spec,
    capturedAt: card.capturedAt,
  } as unknown as Block;
}

/**
 * Which field of a kind's content holds the readings.
 *
 * The wire splits a block into `spec` — what was asked for, in what unit, by
 * which expression — and `data`, what came back. The block components take the
 * shape the rest of Horizon uses, where the two are one object, so they are put
 * back together here.
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

/** Put a flat envelope back into the card shape the blocks read. */
export function rebuildCard(envelope: {
  kind?: string;
  capturedAt?: number;
  spec?: Record<string, unknown>;
  data?: unknown;
}): GraphicCard {
  const kind = envelope.kind ?? '';
  const spec = envelope.spec ?? {};
  if (kind === 'figure') {
    const { layout, groupTitle, xaxis, ...widget } = spec;
    return {
      type: 'figure',
      capturedAt: envelope.capturedAt,
      title: groupTitle,
      layout: layout ?? 'single',
      figures: [{ spec: widget, result: envelope.data ?? {}, xaxis }],
    } as unknown as GraphicCard;
  }
  const field = READINGS_FIELD[kind];
  return {
    type: kind,
    capturedAt: envelope.capturedAt,
    spec: field && envelope.data !== undefined ? { ...spec, [field]: envelope.data } : spec,
  } as unknown as GraphicCard;
}
