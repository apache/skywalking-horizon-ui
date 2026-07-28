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
 * triggers skill — the ONE place the assistant can drive a mutating action, and
 * it never fires it directly. `propose_profiling` presents a DECISION CARD (the
 * analyzed cause, why profiling, what it expects to reveal) that the user
 * approves or dismisses in a popout; only on approve does the UI call the
 * existing verb-gated profile-create route. Gated on profile:enable so the
 * assistant never proposes what the caller couldn't approve.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AiRequestContext } from '../../context.js';
import type { ProfilingProposalType } from '../../types.js';
import { toolPrompt } from '../../resources/loader.js';
import {
  analyzeProfiling,
  analyzeNetworkProfiling,
  findInstanceWithProcesses,
  listServiceInstances,
  serviceCanEbpfProfile,
} from '../../../logic/oap/profiling.js';
import type { ProfilingAnalysis } from '../../../logic/oap/profiling.js';
import { layerCapabilities } from '../../../logic/layers/capabilities.js';
import { resolveEffectiveLayer } from '../../../logic/layers/effective.js';
import { getServerOffsetMinutes } from '../../../util/window.js';

// Which template `components` flag gates each proposable profiling type — the
// layer must declare it for the type to be offer-able. Read at runtime; never
// hardcode which layers support what.
const PROFILING_COMPONENT: Record<ProfilingProposalType, string> = {
  trace: 'traceProfiling',
  async: 'asyncProfiling',
  pprof: 'pprofProfiling',
  ebpf: 'ebpfProfiling',
  network: 'networkProfiling',
};
function supportedProfilingTypes(components: string[]): ProfilingProposalType[] {
  return (Object.keys(PROFILING_COMPONENT) as ProfilingProposalType[]).filter((ty) =>
    components.includes(PROFILING_COMPONENT[ty]),
  );
}

// OAP's Language enum is a closed set (UNKNOWN, JAVA, DOTNET, NODEJS, PYTHON,
// RUBY, GO, LUA, PHP), so match it exactly — a substring test would also let
// 'javascript'-style values through on a future enum entry.
const JVM_LANGUAGES = new Set(['java', 'jvm', 'kotlin', 'scala']);
const GO_LANGUAGES = new Set(['go', 'golang']);

const ASYNC_EVENTS = ['CPU', 'ALLOC', 'LOCK', 'WALL', 'CTIMER', 'ITIMER'];
const PPROF_EVENTS = ['CPU', 'HEAP', 'BLOCK', 'MUTEX', 'GOROUTINE', 'ALLOCS', 'THREADCREATE'];
// async caps at 600s server-side; keep the proposed minutes honest so the card
// and the fired task agree (trace/pprof are minutes; eBPF's 30-min cap is looser).
const MAX_ASYNC_MINUTES = 10;

// Top frames as text so the agent can reason about the hot path (the flame
// itself is rendered for the user, not readable by the model). The ranking
// metric is flavor-specific and MUST be labelled as what it is: trace's
// durationChildExcluded is self MILLISECONDS, pprof/async's is a self SAMPLE
// count, and eBPF has no self time at all (durationChildExcluded is the
// inclusive dumpCount). Numerator and denominator always share one unit.
function summarizeProfile(a: ProfilingAnalysis): string {
  const all = a.trees.flatMap((t) => t.elements);
  if (!all.length) return '';
  const pct = (v: number, total: number): string => `${Math.round((v / total) * 100)}%`;
  if (a.profilingType === 'ebpf') {
    const total = Math.max(...all.map((e) => e.count), 1);
    const top = [...all]
      .filter((e) => e.count > 0)
      .sort((x, y) => y.count - x.count)
      .slice(0, 8)
      .map((e) => `${e.codeSignature} (${pct(e.count, total)})`);
    return top.length
      ? ` Heaviest frames by INCLUSIVE sample share (eBPF carries no self time, so entry/root frames rank highest — read the tree, not the order, for the hot leaf): ${top.join('; ')}.`
      : '';
  }
  const totalSelf = all.reduce((n, e) => n + Math.max(e.durationChildExcluded, 0), 0);
  if (totalSelf <= 0) return '';
  const top = [...all]
    .filter((e) => e.durationChildExcluded > 0)
    .sort((x, y) => y.durationChildExcluded - x.durationChildExcluded)
    .slice(0, 8)
    .map((e) => `${e.codeSignature} (${pct(e.durationChildExcluded, totalSelf)})`);
  const basis =
    a.profilingType === 'trace'
      ? `self time (share of ${Math.round(totalSelf)}ms total self time)`
      : `self samples (share of ${totalSelf} total self samples)`;
  return top.length ? ` Hottest frames by ${basis}: ${top.join('; ')}.` : '';
}

export function triggerTools(ctx: AiRequestContext): StructuredToolInterface[] {
  const t = toolPrompt('triggers', 'propose_profiling');
  const propose = tool(
    async ({ layer, serviceId, service, profilingType, durationMinutes, endpoint, event, targetType, cause, rationale, expectation }): Promise<string> => {
      if (!ctx.hasVerb('profile:enable')) {
        return 'You lack permission to start profiling (profile:enable). Do not propose it; explain what a profiling task would reveal instead.';
      }
      const layerKey = layer.toUpperCase();
      // No descriptor means we could NOT read what the layer offers — never the
      // same thing as "it offers this". Blocked (store down / layer disabled) is
      // a refusal; a layer that simply ships no template still gets its card,
      // flagged as unconfirmed, so a legitimate proposal isn't hard-failed.
      let unconfirmed = '';
      const cap = await layerCapabilities(ctx.uiTemplateClient, layerKey);
      if (cap) {
        const supported = supportedProfilingTypes(cap.components);
        if (!supported.includes(profilingType)) {
          return `The ${layerKey} layer does not support ${profilingType} profiling (it supports: ${supported.join(', ') || 'none'}). Read kb_layer_capabilities and propose a supported type, or tell the user profiling is unavailable here.`;
        }
      } else if ((await resolveEffectiveLayer(ctx.uiTemplateClient, layerKey)).blocked) {
        return `I could not read ${layerKey}'s capabilities — its layer template is unreachable or disabled — so I cannot confirm ${layerKey} supports ${profilingType} profiling, and no card was shown. Read kb_layer_capabilities for ${layerKey} first; if that comes back empty too, tell the user profiling support cannot be confirmed at this deployment.`;
      } else {
        unconfirmed = ` NOTE: ${layerKey} has no layer template here, so I could NOT confirm it supports ${profilingType} profiling — say that when you tell the user, and expect the task creation to fail if this deployment does not actually support it.`;
      }
      // Trace profiling monitors ONE endpoint: OAP's ProfileTaskCreationRequest
      // takes `endpointName: String!` and rejects an empty one, so a card without
      // it can only fail on approve. Refuse to emit it and ask for the endpoint.
      if (profilingType === 'trace' && !endpoint?.trim()) {
        return `Trace profiling monitors ONE endpoint, and OAP requires its name — you did not supply one, so no card was shown. Pick the endpoint of ${service} you want profiled (kb_resolve_scope_drill with toScope "endpoint", or the endpoint you already identified in this investigation), then call propose_profiling again with it.`;
      }
      // async / pprof / network target instances — resolve them server-side so
      // the card can fire without the agent enumerating ids.
      let instanceIds: string[] | undefined;
      let instanceLabel: string | undefined;
      if (profilingType === 'async' || profilingType === 'pprof' || profilingType === 'network') {
        const insts = await listServiceInstances(ctx.opts, serviceId, ctx.window);
        if (!insts.length) {
          return `No instances found for ${service} in the current window — ${profilingType} profiling targets instances. Widen the time range, or use trace/eBPF profiling instead.`;
        }
        if (profilingType === 'network') {
          // OAP rejects a network task on an instance with no processes ("The
          // instance doesn't have processes"), so target one whose processes
          // actually report rather than the fleet's first.
          // Deliberately NOT gated on queryPrepareCreateEBPFProfilingTaskData:
          // that counts processes advertising SUPPORT_EBPF_PROFILING, while a
          // network task only needs ANY non-virtual process on the instance
          // (getProcessCount(instanceId)). Using it here would reject valid
          // targets. The per-instance scan matches the real create check.
          const probeOffset = await getServerOffsetMinutes(ctx.config, ctx.fetch);
          const probe = await findInstanceWithProcesses(ctx.opts, insts, probeOffset);
          if (!probe.instance) {
            if (probe.error) {
              return `Could not check whether ${service}'s instances report a process — every lookup failed (${probe.error}). No card was shown. Say the check could not be completed; do NOT tell the user network profiling is unavailable, that is not what this means.`;
            }
            // A bounded scan and any failed lookup both weaken the negative — say
            // exactly what was and was not checked.
            const caveats = [
              probe.checked < probe.total ? `I only checked ${probe.checked} of its ${probe.total} instances` : null,
              probe.failed > 0 ? `${probe.failed} lookup(s) failed` : null,
            ].filter(Boolean);
            const conclusive = caveats.length === 0;
            return `None of ${service}'s instances I checked reports a process in the last 30 minutes, and OAP rejects a network-profiling task on an instance with no processes — no card was shown.${caveats.length ? ` Note ${caveats.join('; ')}, so this is not conclusive — ask the user which instance to profile.` : ''}${conclusive ? ` Network profiling needs a Rover eBPF agent on the target host; tell the user it looks unavailable for ${service}.` : ''}`;
          }
          instanceIds = [probe.instance.id];
          instanceLabel = probe.instance.name;
        } else {
          // async-profiler is JVM-only, pprof is Go-only — target ONLY the
          // instances that can run it, never the whole fleet. OAP reports
          // "UNKNOWN" (never null) when it can't tell, so those stay in and a
          // fleet with no language data still profiles. Uses the runtime
          // language, not a per-layer assumption.
          const wantGo = profilingType === 'pprof';
          const runnable = wantGo ? GO_LANGUAGES : JVM_LANGUAGES;
          const targets = insts.filter((i) => {
            const l = (i.language ?? '').toLowerCase();
            return !l || l === 'unknown' || runnable.has(l);
          });
          if (!targets.length) {
            const langs = [...new Set(insts.map((i) => (i.language ?? '').toLowerCase()).filter(Boolean))];
            return `${service}'s instances report ${langs.join('/')}, but ${profilingType} profiling is ${wantGo ? 'Go' : 'JVM'}-only. Propose ${wantGo ? 'async (JVM) or trace' : 'pprof (Go) or trace'} instead — match the profiler to the runtime language.`;
          }
          instanceIds = targets.map((i) => i.id);
          instanceLabel =
            targets.length === 1
              ? targets[0].name
              : targets.length === insts.length
                ? `${targets.length} instances`
                : `${targets.length} of ${insts.length} instances (${wantGo ? 'Go' : 'JVM'} runtime)`;
        }
      }
      // eBPF CPU profiling is the one type this query actually gates: OAP's own
      // create form uses it, counting processes that advertise
      // SUPPORT_EBPF_PROFILING. A false is conclusive here (unlike for network,
      // whose create check is weaker), so refuse rather than emit a doomed card.
      if (profilingType === 'ebpf') {
        const ready = await serviceCanEbpfProfile(ctx.opts, serviceId);
        if (ready.error) {
          return `Could not check whether ${service} has an eBPF-profilable process — the lookup failed (${ready.error}). No card was shown. Say the check could not be completed rather than that eBPF profiling is unavailable.`;
        }
        if (!ready.could) {
          return `${service} has no process advertising eBPF-profiling support in the last 10 minutes, so OAP would reject an eBPF task — no card was shown. eBPF profiling needs a Rover agent on the target host; tell the user it is unavailable for ${service}.`;
        }
      }
      // Normalise the event to one this profiler knows (default CPU) so the card
      // never fires a garbage event the BFF would silently drop.
      let events: string[] | undefined;
      if (profilingType === 'async' || profilingType === 'pprof') {
        const known = profilingType === 'async' ? ASYNC_EVENTS : PPROF_EVENTS;
        const ev = (event ?? 'CPU').toUpperCase();
        events = [known.includes(ev) ? ev : 'CPU'];
      }
      const effMinutes = profilingType === 'async' ? Math.min(durationMinutes, MAX_ASYNC_MINUTES) : durationMinutes;
      ctx.emitProposal({
        kind: 'profiling',
        profilingType,
        layer: layerKey,
        serviceId,
        service,
        durationMinutes: effMinutes,
        ...(endpoint ? { endpoint } : {}),
        ...(instanceIds ? { instanceIds, instanceLabel } : {}),
        ...(events ? { events } : {}),
        ...(profilingType === 'ebpf' ? { targetType: targetType ?? 'ON_CPU', processLabels: [] } : {}),
        cause,
        rationale,
        expectation,
      });
      return `Proposed a ${profilingType}-profiling task to the user as a decision card${instanceLabel ? ` (targets: ${instanceLabel})` : ''}. It is NOT running — the user must approve it. Do not analyze now; stop here, tell the user to approve it, and that once it has collected data you will call analyze_profiling to read the result.${unconfirmed}`;
    },
    {
      name: 'propose_profiling',
      description: t.description,
      schema: z.object({
        layer: z.string().describe(t.p('layer')),
        serviceId: z.string().describe(t.p('serviceId')),
        service: z.string().describe(t.p('service')),
        profilingType: z.enum(['trace', 'async', 'pprof', 'ebpf', 'network']).describe(t.p('profilingType')),
        durationMinutes: z.number().int().min(1).max(15).describe(t.p('durationMinutes')),
        endpoint: z.string().optional().describe(t.p('endpoint')),
        event: z.string().optional().describe(t.p('event')),
        targetType: z.enum(['ON_CPU', 'OFF_CPU']).optional().describe(t.p('targetType')),
        cause: z.string().describe(t.p('cause')),
        rationale: z.string().describe(t.p('rationale')),
        expectation: z.string().describe(t.p('expectation')),
      }),
    },
  );

  const at = toolPrompt('triggers', 'analyze_profiling');
  const analyze = tool(
    async ({ layer, service, profilingType, taskId }): Promise<string> => {
      // Same read verb the profiling routes require — the assistant never widens
      // the caller's read scope (profile:enable does NOT imply profile:read).
      if (!ctx.hasVerb('profile:read')) {
        return 'Permission denied: the current user lacks profile:read. Do not analyze; say profiling results are not readable for this user.';
      }
      // Network profiling has no flame — its result is a process-conversation
      // graph. CAPTURE it and render a frozen block (never a live tab, which would
      // drift). When no processes report — Rover/eBPF absent — say it out in text.
      if (profilingType === 'network') {
        // A network task pins the instance it watched AND the window it ran in —
        // the chat's time range is the wrong scope for a task that already
        // finished, so the read follows the task and only degrades to a live
        // probe when there is none. The spec carries no window field, so the
        // scope rides in the block title and in this reply.
        const r = await analyzeNetworkProfiling({
          opts: ctx.opts,
          layerKey: layer,
          service,
          window: ctx.window,
          offsetMinutes: await getServerOffsetMinutes(ctx.config, ctx.fetch),
          taskId,
        });
        const topo = r.topology;
        const windowLabel = `${r.queried.start} to ${r.queried.end}`;
        const scope = r.taskId ? `task ${r.taskId}, ${windowLabel}` : `no NETWORK task — chat window ${windowLabel}`;
        if (!topo.reachable) {
          // Only claim a scope we actually read — a failed task lookup never
          // queried a window at all, and its error already names the cause.
          const where = r.taskId ? ` (${scope})` : '';
          return `Could not read the network-profiling result for ${service}${where}: ${topo.error ?? 'unreachable'}.`;
        }
        if (!topo.nodes.length) {
          return `No process-conversation data for ${service} (${scope}) — network/eBPF profiling needs a Rover eBPF agent, and none reported in that scope. Tell the user network profiling is unavailable here.`;
        }
        ctx.emitProcessTopology({
          title: `Network profiling — ${service} · ${scope}`,
          layer: layer.toUpperCase(),
          service,
          instanceName: r.instanceName,
          replayData: topo,
        });
        return `Rendered the network process-conversation graph for ${service} (instance ${r.instanceName ?? 'unknown'}; ${scope}; times are OAP-server local): ${topo.nodes.length} process(es), ${topo.calls.length} conversation(s).`;
      }
      const a = await analyzeProfiling({ opts: ctx.opts, profilingType, layerKey: layer, service, taskId });
      ctx.emitProfiling({
        title: `Profiling — ${service} (${profilingType})`,
        profilingType: a.profilingType,
        layer: layer.toUpperCase(),
        service,
        taskId: a.taskId,
        trees: a.trees,
        metricKey: a.metricKey,
        tip: a.tip,
        logs: a.logs,
        summary: a.summary,
        ...(a.traceContext ? { traceContext: a.traceContext } : {}),
        reachable: a.reachable,
        error: a.error ?? null,
      });
      if (!a.reachable) return `Could not read the ${profilingType} profile for ${service}: ${a.error ?? 'unreachable'}.`;
      if (!a.trees.length) {
        const why = a.error ? ` (${a.error})` : '';
        // Empty result ≠ unsupported. Only trace fills segmentCount, and eBPF
        // fills neither logs nor segments — the one signal every flavor carries
        // is that a task was RESOLVED (its id + facts land on the summary), so
        // branch on that before blaming the deployment.
        const collected = a.logs.length > 0 || (a.summary.segmentCount ?? 0) > 0;
        const taskFound = !!a.taskId && (a.summary.startTime != null || a.summary.durationLabel != null);
        if (collected) {
          return `The ${profilingType} profiling task for ${service} ran but produced no analyzable stacks${why} — nothing met the sampling threshold. Tell the user; do not retry indefinitely.`;
        }
        if (taskFound) {
          return `The ${profilingType} profiling task for ${service} (task ${a.taskId}) exists but has reported no stacks yet${why}. If it was JUST created, give it 2–4 minutes to collect, then analyze once more. If it has been running well past its window with nothing, say the agent likely cannot collect ${profilingType} profiles here (missing plugin / eBPF host access) — do not retry indefinitely.`;
        }
        return `No ${profilingType} profiling task was found for ${service}${why} — nothing has been analyzed. Either none has been created yet (propose one with propose_profiling and tell the user to approve it), or ${profilingType} profiling is unavailable at this deployment. Do not retry blindly.`;
      }
      return `Rendered the ${profilingType} profile for ${service}: ${a.summary.frameCount} stack frames${a.tip ? ` (partial — ${a.tip})` : ''}.${summarizeProfile(a)}`;
    },
    {
      name: 'analyze_profiling',
      description: at.description,
      schema: z.object({
        layer: z.string().describe(at.p('layer')),
        service: z.string().describe(at.p('service')),
        profilingType: z.enum(['trace', 'pprof', 'async', 'ebpf', 'network']).describe(at.p('profilingType')),
        taskId: z.string().optional().describe(at.p('taskId')),
      }),
    },
  );

  return [propose, analyze];
}
