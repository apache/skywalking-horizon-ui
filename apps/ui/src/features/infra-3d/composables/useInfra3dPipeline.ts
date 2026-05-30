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
 * Pipeline state machine for the 3D Infrastructure Map.
 *
 *   stage 1: services    — list services with their layer
 *   stage 2: templates   — flag layers that ship a topology widget
 *   stage 3: topologies  — pull per-layer service-map snapshot
 *   stage 4: layout      — client-side placement (re)compute
 *   stage 5: metrics     — chunked traffic-MQE fetch, server-pref
 *
 * Each stage owns a typed state + detail blob the bottom-of-page
 * timeline reads to render its drawer. The pipeline is iteration-1
 * scaffolding: it surfaces operator-visible progress for the demo
 * snapshot today; stage 5 wires through to live OAP MQE fetches in
 * the next iteration. The shape is stable so the timeline UI doesn't
 * need to change as later stages light up.
 *
 * Threading: each stage is awaited sequentially — operators read the
 * map as it builds bottom-up, and the parallelism that does exist is
 * intra-stage (e.g. concurrent template / topology / metric chunks).
 * The concurrency caps come from `infraConfig.pipeline.*` so an admin
 * can throttle a noisy OAP without a code edit.
 */

import { readonly, shallowRef } from 'vue';
import { ensureLoaded as ensureInfraConfigLoaded } from './useInfra3dConfig';

export type PipelineStageId = 'services' | 'templates' | 'topologies' | 'layout' | 'metrics';
export type PipelineStageStatus = 'idle' | 'running' | 'ok' | 'warn' | 'error';

/** A row inside the drawer for stage 3 (per-layer topology probe).
 *  `ok` carries the latency in ms; `failed` carries an error string;
 *  `empty` means OAP returned an empty topology for the window. */
export interface TopologyProbe {
  layerKey: string;
  status: 'ok' | 'empty' | 'failed';
  ms?: number;
  error?: string;
  nodeCount?: number;
  edgeCount?: number;
}

/** Per-stage state. Each stage carries the same shape — `status`,
 *  `startedAt`, `endedAt`, plus a stage-specific `detail` blob the
 *  drawer renders verbatim. */
export interface StageState {
  id: PipelineStageId;
  status: PipelineStageStatus;
  /** ms epoch */
  startedAt: number | null;
  /** ms epoch */
  endedAt: number | null;
  /** Short status line rendered next to the icon ("65 svc / 17 layers"). */
  summary: string;
  detail: StageDetail;
}

export type StageDetail =
  | { kind: 'services'; servicesTotal: number; layersTotal: number; addedSince: number | null; removedSince: number | null; hiddenNoTemplate?: string[] }
  | { kind: 'templates'; layersWithTopology: string[]; layersWithoutTopology: string[] }
  | { kind: 'topologies'; probes: TopologyProbe[] }
  | { kind: 'layout'; layersReLaid: number; ms: number }
  | { kind: 'metrics'; servicesTotal: number; servicesDone: number; chunkIndex: number; chunkTotal: number; currentLevel: string | null }
  | { kind: 'empty' };

const emptyDetail: StageDetail = { kind: 'empty' };

const STAGE_ORDER: PipelineStageId[] = ['services', 'templates', 'topologies', 'layout', 'metrics'];

function initialState(): Record<PipelineStageId, StageState> {
  return Object.fromEntries(
    STAGE_ORDER.map((id) => [
      id,
      { id, status: 'idle' as PipelineStageStatus, startedAt: null, endedAt: null, summary: '', detail: emptyDetail },
    ]),
  ) as Record<PipelineStageId, StageState>;
}

const stages = shallowRef<Record<PipelineStageId, StageState>>(initialState());
const running = shallowRef(false);
const completedAt = shallowRef<number | null>(null);

function patchStage(id: PipelineStageId, patch: Partial<StageState>): void {
  stages.value = { ...stages.value, [id]: { ...stages.value[id], ...patch } };
}

/** Hook for stages that need to publish progress AS THEY GO (most
 *  visibly stage 5 — chunked metrics). The composable can pass this
 *  into stage implementations so they don't need to know about the
 *  shallowRef. */
export interface StageReporter {
  start: (summary?: string) => void;
  progress: (summary: string, detail: StageDetail) => void;
  ok: (summary: string, detail: StageDetail) => void;
  warn: (summary: string, detail: StageDetail) => void;
  fail: (err: unknown) => void;
}
function reporterFor(id: PipelineStageId): StageReporter {
  return {
    start(summary?: string) {
      patchStage(id, {
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        summary: summary ?? '',
        detail: emptyDetail,
      });
    },
    progress(summary, detail) {
      patchStage(id, { status: 'running', summary, detail });
    },
    ok(summary, detail) {
      patchStage(id, { status: 'ok', endedAt: Date.now(), summary, detail });
    },
    warn(summary, detail) {
      patchStage(id, { status: 'warn', endedAt: Date.now(), summary, detail });
    },
    fail(err) {
      patchStage(id, {
        status: 'error',
        endedAt: Date.now(),
        summary: err instanceof Error ? err.message : String(err),
      });
    },
  };
}

/** A pipeline stage implementation — takes a reporter and a context
 *  shared across stages (so e.g. stage 3 can reach what stage 1
 *  produced without going through the reactive state). */
export type StageImpl<C> = (reporter: StageReporter, ctx: C) => Promise<void>;

/** Run the pipeline. Stages run sequentially in `STAGE_ORDER`. The
 *  caller supplies a context object the stage impls share — the
 *  default impls below populate it for downstream stages.
 *
 *  Cancellation: re-invoking `run()` while one is in-flight is a
 *  no-op; the caller should debounce or wait. The current call's
 *  signal is exposed via `running`. */
export async function run<C>(
  ctx: C,
  impls: Record<PipelineStageId, StageImpl<C>>,
  only?: PipelineStageId[],
): Promise<void> {
  if (running.value) return;
  running.value = true;
  completedAt.value = null;
  // A full run resets every stage; a partial (light) run runs only `only`
  // and leaves the unselected stages showing their last full-run result.
  if (!only) stages.value = initialState();
  await ensureInfraConfigLoaded().catch(() => {
    // Config load is a hard prereq; without it the scene can't even
    // mount, so a failure here should still let the pipeline fail
    // visibly. We don't throw — the reporter inside each stage will
    // surface specific failures as it touches its data.
  });
  try {
    for (const id of STAGE_ORDER) {
      if (only && !only.includes(id)) continue;
      const reporter = reporterFor(id);
      try {
        await impls[id](reporter, ctx);
      } catch (err) {
        reporter.fail(err);
        // Bail out on the first hard failure — later stages depend on
        // earlier output, and reporting all as `error` would obscure
        // the originating fault.
        break;
      }
    }
    completedAt.value = Date.now();
  } finally {
    running.value = false;
  }
}

export function useInfra3dPipeline() {
  return {
    stages: readonly(stages),
    running: readonly(running),
    completedAt: readonly(completedAt),
    stageOrder: STAGE_ORDER,
    run,
  };
}
