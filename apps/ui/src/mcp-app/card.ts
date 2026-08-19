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

export function toBlock(card: GraphicCard): Block {
  if (card.type === 'figure') {
    return {
      kind: 'figure',
      n: card.n,
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
    return { kind: 'proposal', n: card.n, spec: card.spec, status: 'proposed' } as Block;
  }
  return {
    kind: card.type,
    n: card.n,
    spec: card.spec,
    capturedAt: card.capturedAt,
  } as unknown as Block;
}
