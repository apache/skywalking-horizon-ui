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
import { EMITS_CARD } from '../../graphic-card.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ToolContext } from '../../tool-context.js';
import type { ProfilingProposalType } from '../../graphic-card.js';
import { toolPrompt } from '../../skills/loader.js';
import {
  analyzeProfiling,
  analyzeNetworkProfiling,
  findInstanceWithProcesses,
  listServiceInstances,
  serviceCanEbpfProfile,
} from '../../../../logic/oap/profiling.js';
import type { ProfilingAnalysis } from '../../../../logic/oap/profiling.js';
import { layerCapabilities } from '../../../../logic/layers/capabilities.js';
import { resolveEffectiveLayer } from '../../../../logic/layers/effective.js';
import { getServerOffsetMinutes } from '../../../../util/window.js';

// Horizon-side template config, NOT an OAP capability: none of OAP's five
// profiling create paths takes a layer, so a missing type is a hint, not proof
// the backend would refuse.
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

/** How far past its window a task may run before "still collecting" stops being
 *  credible. Generous: upload and analysis land after sampling stops. */
const STALE_TASK_GRACE_SEC = 5 * 60;

/** Mirrors `MAX_TARGET_INSTANCES` in the async/pprof create routes, which reject
 *  rather than slice — a card advertising more is a card that cannot fire. */
const MAX_PROPOSED_INSTANCES = 32;
const PPROF_EVENTS = ['CPU', 'HEAP', 'BLOCK', 'MUTEX', 'GOROUTINE', 'ALLOCS', 'THREADCREATE'];

// Top frames as text — the flame is rendered for the user, not readable by the
// model. The ranking metric is flavour-specific and MUST be labelled as what it
// is: trace is self MILLISECONDS, pprof/async a self SAMPLE count, and eBPF has
// no self time at all.
function summarizeProfile(a: ProfilingAnalysis): string {
  const all = a.trees.flatMap((t) => t.elements);
  if (!all.length) return '';
  const pct = (v: number, total: number): string => `${Math.round((v / total) * 100)}%`;
  if (a.profilingType === 'ebpf') {
    // Mirrors the aggregate the eBPF read asked OAP for: OFF_CPU by DURATION,
    // ON_CPU by COUNT. Naming the wrong one has the model call a count "time".
    const offCpu = a.summary.events?.[0] === 'OFF_CPU';
    const total = Math.max(...all.map((e) => e.count), 1);
    const top = [...all]
      .filter((e) => e.count > 0)
      .sort((x, y) => y.count - x.count)
      .slice(0, 8)
      .map((e) => `${e.codeSignature} (${pct(e.count, total)})`);
    const basis = offCpu ? 'INCLUSIVE share of time spent OFF-CPU (blocked)' : 'INCLUSIVE share of on-CPU dump count';
    return top.length
      ? ` Heaviest frames by ${basis} (eBPF carries no self time, so entry/root frames rank highest — read the tree, not the order, for the hot leaf): ${top.join('; ')}.`
      : '';
  }
  const totalSelf = all.reduce((n, e) => n + Math.max(e.durationChildExcluded, 0), 0);
  if (totalSelf <= 0) return '';
  const top = [...all]
    .filter((e) => e.durationChildExcluded > 0)
    .sort((x, y) => y.durationChildExcluded - x.durationChildExcluded)
    .slice(0, 8)
    .map((e) => `${e.codeSignature} (${pct(e.durationChildExcluded, totalSelf)})`);
  // async-profiler does NOT rank every event by sample count. OAP's JFR
  // converter builds EXECUTION_SAMPLE with `EventAggregator(true, false)` —
  // sample counts — but ALLOC and LOCK with `EventAggregator(true, true)`,
  // which SUMS each event's own value: bytes allocated for AllocationSample,
  // and for ContendedLock a duration scaled to nanoseconds. Calling either
  // "samples" hands the model a unit that is not what it is reading.
  const asyncEvent = a.profilingType === 'async' ? (a.summary.events?.[0] ?? '').toUpperCase() : '';
  const basis =
    a.profilingType === 'trace'
      ? `self time (share of ${Math.round(totalSelf)}ms total self time)`
      : asyncEvent === 'ALLOC'
        ? `self BYTES ALLOCATED (share of ${totalSelf} bytes total) — this is memory volume, not a sample count`
        : asyncEvent === 'LOCK'
          ? `self LOCK-CONTENTION TIME in nanoseconds (share of ${totalSelf}ns total) — this is time blocked, not a sample count`
          : `self samples (share of ${totalSelf} total self samples)`;
  // OAP counts pprof sample RECORDS and discards each sample's own value, so
  // for HEAP / ALLOCS the top frame has the most distinct allocation stacks,
  // not the most memory.
  const memoryEvent =
    a.profilingType === 'pprof' && ['HEAP', 'ALLOCS'].includes((a.summary.events?.[0] ?? '').toUpperCase());
  const caveat = memoryEvent
    ? ' NOTE: this is a count of sample records, NOT bytes — it ranks by how many distinct allocation stacks hit a frame, not by memory held or allocated. Do not report it as a memory figure.'
    : '';
  return top.length ? ` Hottest frames by ${basis}: ${top.join('; ')}.${caveat}` : '';
}

export function triggerTools(ctx: ToolContext): StructuredToolInterface[] {
  const t = toolPrompt('triggers', 'propose_profiling');
  const propose = tool(
    async ({ layer, serviceId, service, profilingType, durationMinutes, endpoint, event, targetType, instances, cause, rationale, expectation }): Promise<string> => {
      if (!ctx.hasVerb('profile:enable')) {
        return 'You lack permission to start profiling (profile:enable). Do not propose it; explain what a profiling task would reveal instead.';
      }
      const layerKey = layer.toUpperCase();
      // Readiness signals are ADVICE, never a veto: OAP's checkCreateRequest /
      // checkArgumentError consult none of what we can see here, so a
      // Horizon-side "no" would block a task the backend would have taken.
      const caveats: string[] = [];
      const cap = await layerCapabilities(ctx.uiTemplateClient, layerKey);
      if (cap) {
        const supported = supportedProfilingTypes(cap.components);
        if (!supported.includes(profilingType)) {
          caveats.push(
            `${layerKey}'s layer template does not list ${profilingType} profiling (it lists: ${supported.join(', ') || 'none'}). That template is Horizon-side configuration — OAP applies no layer gate to profiling — so the task may well be accepted. Say the layer isn't set up for it, NOT that the deployment cannot do it.`,
          );
        }
      } else if ((await resolveEffectiveLayer(ctx.uiTemplateClient, layerKey)).blocked) {
        caveats.push(`${layerKey}'s layer template is unreachable or disabled, so I could not read what it advertises. This says nothing about whether OAP accepts the task.`);
      } else {
        caveats.push(`${layerKey} ships no layer template here, so I could not read what it advertises. This says nothing about whether OAP accepts the task.`);
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
          if (probe.instance) {
            instanceIds = [probe.instance.id];
            instanceLabel = probe.instance.name;
          } else {
            // Our probe is time-scoped; OAP's create check is NOT — it counts
            // processes on the instance with no window at all. So a miss here
            // (idle host, minute-bucket boundary, bounded scan, failed lookups)
            // is weaker evidence than OAP's own gate. Target the first instance
            // and let `getProcessCount` decide; its "The instance doesn't have
            // processes." is the accurate answer, ours would be a guess.
            instanceIds = [insts[0].id];
            instanceLabel = insts[0].name;
            const scope = [
              probe.error ? `every process lookup failed (${probe.error})` : null,
              probe.checked < probe.total ? `only ${probe.checked} of ${probe.total} instances were checked` : null,
              probe.failed > 0 ? `${probe.failed} lookup(s) failed` : null,
            ].filter(Boolean);
            caveats.push(
              `No process reported recently on the instances I could check${scope.length ? ` (${scope.join('; ')})` : ''}, so I targeted ${insts[0].name}. OAP checks this itself without a time window when the task is created — if it rejects with "The instance doesn't have processes", THAT is the real answer, and it points at a missing Rover eBPF agent. Do not claim that before approval.`,
            );
          }
        } else {
          // async-profiler is JVM-only and pprof is Go-only as a matter of what
          // the AGENT can collect — OAP itself applies no language check, so this
          // steers TARGETING (profile the instances that can actually run it),
          // it does not decide whether the task may exist. When the runtime rules
          // every instance out, the reported language is the thing most likely to
          // be wrong (a mislabelled or re-registered instance), so target the
          // fleet and flag it rather than refusing a task OAP would accept.
          const wantGo = profilingType === 'pprof';
          const runnable = wantGo ? GO_LANGUAGES : JVM_LANGUAGES;
          const runsIt = (i: (typeof insts)[number]): boolean => {
            const l = (i.language ?? '').toLowerCase();
            return !l || l === 'unknown' || runnable.has(l);
          };
          // Explicit narrowing wins over the language heuristic and is checked
          // against the FULL instance list, not the language-filtered one — an
          // instance the caller named because they believe its reported
          // language is wrong must not be reported as "does not exist" for
          // having failed a filter the caller is explicitly overriding.
          const wanted = (instances ?? []).map((n) => n.toLowerCase());
          let narrowed: typeof insts;
          if (wanted.length) {
            narrowed = insts.filter((i) => wanted.includes(i.name.toLowerCase()));
            const found = new Set(narrowed.map((i) => i.name.toLowerCase()));
            const missing = (instances ?? []).filter((n) => !found.has(n.toLowerCase()));
            if (missing.length) {
              // Reject the whole selection rather than silently dropping the
              // names that did not match — an operator reading "profiling i-1,
              // i-2" must not discover later that i-3 was quietly left out.
              return `${missing.join(', ')} — no instance with that name exists on ${service}. Its instances are: ${insts.map((i) => i.name).join(', ')}. Name only those, or omit the argument to target them all.`;
            }
          } else {
            const targets = insts.filter(runsIt);
            narrowed = targets.length ? targets : insts;
          }
          if (!wanted.length && !narrowed.every(runsIt)) {
            const langs = [...new Set(insts.map((i) => (i.language ?? '').toLowerCase()).filter(Boolean))];
            caveats.push(
              `${service}'s instances report ${langs.join('/')}, and ${profilingType} profiling is ${wantGo ? 'Go' : 'JVM'}-only, so the agent will most likely collect nothing. OAP accepts the task regardless — it applies no language check. Say this plainly and offer ${wantGo ? 'async (JVM) or trace' : 'pprof (Go) or trace'} instead; only go ahead if the user believes the reported runtime is wrong.`,
            );
          }
          // The create routes REJECT more than MAX_TARGET_INSTANCES rather than
          // slicing, so a card above the cap is one the user cannot approve.
          // Refuse to emit it and say how to make it proposable, instead of
          // showing a decision card whose only outcome is a rejection.
          if (narrowed.length > MAX_PROPOSED_INSTANCES) {
            return `${service} has ${narrowed.length} matching instances and a single ${profilingType} task accepts at most ${MAX_PROPOSED_INSTANCES}, so I did not show a card that could not be approved. Call propose_profiling again with the "instances" argument naming at most ${MAX_PROPOSED_INSTANCES} of them, or split the fleet across several tasks. The instances are: ${narrowed.slice(0, 60).map((i) => i.name).join(', ')}${narrowed.length > 60 ? ', …' : ''}.`;
          }
          instanceIds = narrowed.map((i) => i.id);
          const chosenSet = narrowed;
          // The runtime suffix explains a subset the LANGUAGE heuristic produced;
          // a subset the caller named explicitly needs no such explanation.
          const why = wanted.length ? '' : ` (${wantGo ? 'Go' : 'JVM'} runtime)`;
          instanceLabel =
            chosenSet.length === 1
              ? chosenSet[0].name
              : chosenSet.length === insts.length
                ? `${chosenSet.length} instances`
                : `${chosenSet.length} of ${insts.length} instances${why}`;
        }
      }
      // What OAP's own create form shows before enabling its button — processes
      // advertising SUPPORT_EBPF_PROFILING over a rolling 10 minutes. It is a
      // READINESS hint, not the create gate: createEBPFProfilingFixedTimeTask
      // validates only the service, that each submitted label exists, and the
      // 60s minimum duration — it never runs this query. A rover restart or a
      // metadata lag flips it to false on a deployment that profiles fine, so
      // carry it as doubt instead of refusing.
      if (profilingType === 'ebpf') {
        const ready = await serviceCanEbpfProfile(ctx.opts, serviceId);
        if (ready.error) {
          caveats.push(`I could not check whether ${service} has an eBPF-profilable process — the lookup failed (${ready.error}). Say the check could not be completed, not that eBPF profiling is unavailable.`);
        } else if (!ready.could) {
          caveats.push(
            `No process on ${service} advertised eBPF-profiling support in the last 10 minutes, which is what OAP's own create form checks before enabling its button — but the create call itself does not consult it, so the task may still run. eBPF profiling needs a Rover agent on the target host; if it collects nothing, that is the likely reason.`,
          );
        }
      }
      // Default to CPU when no event was named. An event we don't recognise is
      // passed THROUGH: the vocabulary is an OAP GraphQL enum, which validates
      // and rejects with a clear message naming the allowed values. Silently
      // rewriting it to CPU meant the operator approved a card reading "HEAP"
      // and got a CPU profile — a wrong answer beats an honest rejection.
      let events: string[] | undefined;
      if (profilingType === 'async' || profilingType === 'pprof') {
        const known = profilingType === 'async' ? ASYNC_EVENTS : PPROF_EVENTS;
        const ev = (event ?? 'CPU').toUpperCase();
        events = [ev];
        if (!known.includes(ev)) {
          caveats.push(`"${ev}" is not an event I know for ${profilingType} profiling (I know ${known.join(', ')}). I passed it through rather than substituting CPU — if OAP does not accept it, the approve will fail with the list it does accept.`);
        }
      }
      // OAP fixes a NETWORK task at 10 minutes and its create request carries no
      // duration field, so any number the model proposed is fiction.
      if (profilingType === 'network') {
        caveats.push('OAP runs every network-profiling task for a fixed 10 minutes and takes no duration argument, so the collection window you proposed does not apply. Tell the user 10 minutes.');
      }
      ctx.emitProposal({
        kind: 'profiling',
        profilingType,
        layer: layerKey,
        serviceId,
        service,
        durationMinutes,
        ...(endpoint ? { endpoint } : {}),
        ...(instanceIds ? { instanceIds, instanceLabel } : {}),
        ...(events ? { events } : {}),
        ...(profilingType === 'ebpf' ? { targetType: targetType ?? 'ON_CPU', processLabels: [] } : {}),
        cause,
        rationale,
        expectation,
      });
      const notes = caveats.length ? ` Tell the user these caveats BEFORE they approve: ${caveats.join(' ')}` : '';
      return `Proposed a ${profilingType}-profiling task to the user as a decision card${instanceLabel ? ` (targets: ${instanceLabel})` : ''}. It is NOT running — the user must approve it. Do not analyze now; stop here, tell the user to approve it, and that once it has collected data you will call analyze_profiling to read the result.${notes}`;
    },
    {
      name: 'propose_profiling',
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
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
        instances: z.array(z.string()).optional().describe(t.p('instances')),
        cause: z.string().describe(t.p('cause')),
        rationale: z.string().describe(t.p('rationale')),
        expectation: z.string().describe(t.p('expectation')),
      }),
    },
  );

  const at = toolPrompt('triggers', 'analyze_profiling');
  const analyze = tool(
    async ({ layer, service, profilingType, taskId, event }): Promise<string> => {
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
          rangeMs: { startMs: ctx.range.startMs, endMs: ctx.range.endMs },
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
          // An empty graph is NOT proof of a missing agent. A network task runs
          // a server-fixed 10 minutes, so the common sequence — approve, then
          // analyze a minute later — legitimately reads a graph that has not
          // been populated yet. Say what was actually read and let the elapsed
          // window decide; only a task well past its window says anything about
          // the deployment.
          const waiting = r.taskId
            ? ` If this task was created within the last ~10 minutes it is still collecting — say that and analyze again after its window, do NOT conclude anything about the deployment yet.`
            : '';
          return `No process-conversation data for ${service} (${scope}).${waiting} If the window has fully elapsed and the graph is still empty, THEN the likely cause is that no Rover eBPF agent is reporting processes for this service — report that as the likely cause, not as a certainty.`;
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
      const a = await analyzeProfiling({ opts: ctx.opts, profilingType, layerKey: layer, service, taskId, event });
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
        //
        // The LOG's operationType is what says how far the task got, and every
        // flavour shares the vocabulary: NOTIFIED means only "issued to the
        // agent" (still running — NOT a finished-but-empty profile),
        // EXECUTION_FINISHED means the agent is done, and the *_ERROR variants
        // (EXECUTION_TASK_ERROR, JFR/PPROF_UPLOAD_FILE_TOO_LARGE_ERROR) are hard
        // failures. Treating "any log exists" as collected reported all three as
        // "ran but found nothing, do not retry" — which told the operator to
        // give up on a task that was still collecting, or hid a real agent error.
        const failed = a.logs.filter((l) => l.operationType.endsWith('_ERROR'));
        // Counted against the TARGETED fleet, not just whoever showed up in the
        // logs: an instance that never emits a single line is silently absent
        // from `reporting`, so one finisher could otherwise declare a 20-target
        // task complete. Counts rather than a set intersection because the logs
        // key on instanceNAME while the task carries instance IDs.
        const reporting = new Set(a.logs.map((l) => l.instanceName));
        const doneInstances = new Set(
          a.logs.filter((l) => l.operationType === 'EXECUTION_FINISHED').map((l) => l.instanceName),
        );
        const expectedInstances = Math.max(a.summary.instances?.length ?? 0, reporting.size);
        const finished = doneInstances.size > 0 && doneInstances.size >= expectedInstances;
        const taskFound = !!a.taskId && (a.summary.startTime != null || a.summary.durationLabel != null);
        if (failed.length) {
          const kinds = [...new Set(failed.map((l) => l.operationType))].join(', ');
          return `The ${profilingType} profiling task for ${service} (task ${a.taskId}) FAILED on the agent — OAP logged ${kinds} for ${[...new Set(failed.map((l) => l.instanceName))].join(', ')}${why}. This is an agent-side error, not an empty profile: report the failure and what it means (a too-large upload means the profile exceeded what OAP accepts — propose a shorter window), and do not retry unchanged.`;
        }
        // An agent that dies mid-task writes no EXECUTION_FINISHED and no
        // *_ERROR, so without this bound "still running" is returned forever.
        const startedAt = a.summary.startTime ?? null;
        // A snapshot event (HEAP / GOROUTINE / ALLOCS / THREADCREATE) carries no
        // duration, so requiring a window here left those tasks reported as
        // "still collecting" for ever. No window means the work is instant: the
        // grace period alone is the bound.
        const windowSec = a.summary.durationSec ?? 0;
        const elapsedSec = startedAt ? (Date.now() - startedAt) / 1000 : null;
        const overdue = elapsedSec !== null && elapsedSec > windowSec + STALE_TASK_GRACE_SEC;
        if (a.logs.length && !finished && !overdue) {
          return `The ${profilingType} profiling task for ${service} (task ${a.taskId}) has been issued to the agent and is still COLLECTING — no stacks yet${why}. Tell the user it is running and analyze again after its window elapses. Do NOT report this as a profile that found nothing.`;
        }
        if (a.logs.length && !finished) {
          return `The ${profilingType} profiling task for ${service} (task ${a.taskId}) was issued to the agent ${Math.round((elapsedSec ?? 0) / 60)} minutes ago — well past its ${a.summary.durationLabel ?? 'collection'} window — and OAP has logged neither a completion nor an error${why}. The agent most likely stopped reporting (restarted, evicted, or never supported this profiling flavour). Tell the user the task is stalled rather than running, and do not keep waiting on it.`;
        }
        if (finished || (a.summary.segmentCount ?? 0) > 0) {
          // `a.tip` survives an empty `a.trees` — for async it is set whenever
          // the task captured an event this call did not render, regardless of
          // whether THIS event came back empty. A CPU+ALLOC task with nothing on
          // the CPU side can still have a real ALLOC profile; "do not retry"
          // would abandon it unread. Gated to async: trace/eBPF's `tip` is an
          // unrelated OAP truncation notice, not "try a different event".
          if (profilingType === 'async' && a.tip) {
            return `The ${profilingType} profiling task for ${service} (task ${a.taskId}) produced no analyzable stacks for this event${why}, but ${a.tip} Call analyze_profiling again with that event before concluding the task found nothing.`;
          }
          return `The ${profilingType} profiling task for ${service} finished but produced no analyzable stacks${why} — nothing met the sampling threshold. Tell the user; do not retry indefinitely.`;
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
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
      description: at.description,
      schema: z.object({
        layer: z.string().describe(at.p('layer')),
        service: z.string().describe(at.p('service')),
        profilingType: z.enum(['trace', 'pprof', 'async', 'ebpf', 'network']).describe(at.p('profilingType')),
        taskId: z.string().optional().describe(at.p('taskId')),
        event: z.string().optional().describe(at.p('event')),
      }),
    },
  );

  return [propose, analyze];
}
