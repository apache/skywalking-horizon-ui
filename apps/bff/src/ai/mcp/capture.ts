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
 * A capturing {@link ToolContext}.
 *
 * The chat route hands `createGraphicCardBuffer` a sink that writes SSE frames;
 * hand it one that appends to an array and the SAME tools produce the SAME
 * numbered, tab-grouped cards into memory. Numbering, group buffering and the
 * frozen `replayData` capture all live above the transport, so none of it
 * needed changing to serve a second consumer — that is the seam this library
 * was split around.
 */

import type { FetchLike, UITemplateClient } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import { buildOapOpts } from '../../client/graphql.js';
import { sessionHasVerb, type VerbSubject } from '../../rbac/policy.js';
import { defaultMinuteWindow, windowFromRange } from '../../util/window.js';
import { createGraphicCardBuffer } from '../lib/graphic-card-buffer.js';
import type { ToolContext } from '../lib/tool-context.js';
import type { GraphicCard } from '../lib/graphic-card.js';

export type CaptureStep = 'MINUTE' | 'HOUR' | 'DAY';

export interface CaptureDeps {
  config: ConfigSource;
  fetch?: FetchLike;
  uiTemplateClient?: () => UITemplateClient;
  /** The caller. Tools gate on this, so an agent never sees more than the
   *  operator it acts for — and passing the whole subject rather than its roles
   *  is what carries an OAuth scope's cap through to every tool. */
  subject: VerbSubject;
  /** OAP-server-local offset, resolved once by the caller (it needs a fetch). */
  offsetMinutes: number;
  windowMinutes: number;
  step: CaptureStep;
}

export interface CapturedRun {
  ctx: ToolContext;
  /** Call `finish()` before reading — a trailing figure group stays buffered
   *  until flushed, exactly as it does on the SSE path. */
  finish(): GraphicCard[];
}

export function createCaptureContext(deps: CaptureDeps): CapturedRun {
  const cfg = deps.config.current;
  const cards: GraphicCard[] = [];
  const buffer = createGraphicCardBuffer((card) => {
    cards.push(card);
  });

  const endMs = Date.now();
  const startMs = endMs - deps.windowMinutes * 60_000;
  const window =
    windowFromRange(deps.step, startMs, endMs, deps.offsetMinutes) ??
    defaultMinuteWindow(deps.offsetMinutes, deps.windowMinutes);

  const ctx: ToolContext = {
    config: deps.config,
    fetch: deps.fetch,
    uiTemplateClient: deps.uiTemplateClient,
    opts: buildOapOpts(cfg, deps.fetch),
    window,
    range: { startMs, endMs, step: deps.step },
    bulkSize: cfg.performance.bulk.dashboard.bulkSize,
    hasVerb: (verb) => sessionHasVerb(cfg, deps.subject, verb),
    ...buffer,
    // No activity line to paint: an MCP host shows its own tool-call status.
    emitTool: () => {},
  };

  return {
    ctx,
    finish(): GraphicCard[] {
      buffer.flushFigures();
      return cards;
    },
  };
}
