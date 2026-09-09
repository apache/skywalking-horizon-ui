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
 * The document, indexed once. The Sessionizer's page fetched an overview, a
 * flow and one talk tree at a time; here the whole conversation is in hand, so
 * every lookup a view needs is a map built at load: nodes by id, steps per
 * stream in reading order, talks per stream, the streams a talk starts.
 *
 * Measured on the largest real conversation (922 talks, 49,827 steps, a 61 MB
 * document): parsing takes 139 ms and walking every node 5 ms, so nothing here
 * is lazy.
 */

import type {
  AszEdge,
  AszFileChange,
  AszNode,
  AszRef,
  AszSegment,
  AszStream,
  AszViewDocument,
  AszUsage,
  AszDrop,
  AszWorkspaceChange,
} from './types.js';
import { CONTAINER_KINDS, kindOf, type KindType, type Track } from './vocabulary.js';

/** One step as the transcript and the timeline draw it: the node flattened,
 *  with the run and the talk it belongs to and where it sits in reading order. */
export interface Step {
  id: string;
  kind: string;
  at: number;
  parent?: string;
  stream: string;
  run: string | null;
  /** The talk containing it; null for a step outside any talk (`loose`). */
  talk: string | null;
  track: Track;
  type: KindType;
  name?: string;
  text?: string;
  state?: string;
  bytes?: number;
  result?: string;
  resultState?: string;
  resultBytes?: number;
  durationMs?: number;
  durationHow?: string;
  reqToRes?: number;
  reqToResJoin?: string;
  failed?: boolean;
  ref?: AszRef;
  refs?: AszRef[];
  attrs?: Record<string, unknown>;
  usage?: AszUsage;
  flags?: string[];
  dropped?: AszDrop[];
  edges: AszEdge[];
  /** Whether workspace change records join to this step (the node's `changes`). */
  hasChanges: boolean;
  /** Position in the flattened document, for ties and for nodes without a ref. */
  order: number;
  depth: number;
}

/** The records of one step that share a workspace root; the runtime's own
 *  record, when there is one, is `preferred` and the others are one line
 *  away. Records are never merged: two producers can report one call with
 *  different context lines. */
export interface ChangeGroup {
  root: string;
  records: AszWorkspaceChange[];
  preferred: AszWorkspaceChange;
}

/** What a record observed, from its basis and its counts: `skipped` says
 *  the call was not looked at, `unknown` that the count is null, `none`
 *  that a complete observation found nothing, `files` that it found some. */
export type Observation = 'skipped' | 'unknown' | 'none' | 'files';

export function observationOf(r: AszWorkspaceChange): Observation {
  if (r.basis === 'skipped_read_only') return 'skipped';
  if (r.changes && r.changes.length > 0) return 'files';
  // A scan that stopped early and found nothing has not found "nothing".
  if (r.changed_files === null || r.coverage === 'partial') return 'unknown';
  return 'none';
}

/** Whether a record's list of files may be short of what happened: a scan
 *  that stopped early, or a count the record does not carry. */
export function incompleteObservation(r: AszWorkspaceChange): boolean {
  return r.basis !== 'skipped_read_only' && (r.coverage === 'partial' || (r.changed_files === null && !(r.changes && r.changes.length > 0 && r.captured_by === CAPTURED_BY_RUNTIME)));
}

export const CAPTURED_BY_RUNTIME = 'claude-code';

export function groupChanges(records: AszWorkspaceChange[]): ChangeGroup[] {
  const groups = new Map<string, AszWorkspaceChange[]>();
  for (const r of records) push(groups, r.root?.path ?? '', r);
  return [...groups.entries()].map(([root, list]) => ({
    root,
    records: list,
    preferred: list.find((r) => r.captured_by === CAPTURED_BY_RUNTIME) ?? list[0]!,
  }));
}

/** Files counted once by root and path across every record of a step. The
 *  line counts are per record: two windows on one root each net their own
 *  span, so their counts can neither be summed nor deduplicated — they are
 *  carried only when a single record covers the step. */
export interface ChangeTally {
  files: number;
  /** The file count is a floor: a record's scan stopped early or its count is unknown. */
  incomplete: boolean;
  additions: number | null;
  deletions: number | null;
  observation: Observation;
}

export function tallyChanges(records: AszWorkspaceChange[]): ChangeTally {
  const seen = new Set<string>();
  let observation: Observation = 'skipped';
  let incomplete = false;
  const rank: Record<Observation, number> = { skipped: 0, none: 1, unknown: 2, files: 3 };
  for (const r of records) {
    const o = observationOf(r);
    if (rank[o] > rank[observation]) observation = o;
    if (incompleteObservation(r)) incomplete = true;
    for (const c of r.changes ?? []) seen.add(`${r.root?.path ?? ''}|${c.path}`);
  }
  const withFiles = records.filter((r) => (r.changes?.length ?? 0) > 0);
  let additions: number | null = null;
  let deletions: number | null = null;
  if (withFiles.length === 1) {
    for (const c of withFiles[0]!.changes ?? []) {
      if (c.additions === null || c.deletions === null) {
        additions = null;
        deletions = null;
        break;
      }
      additions = (additions ?? 0) + c.additions;
      deletions = (deletions ?? 0) + c.deletions;
    }
  }
  return { files: seen.size, incomplete, additions, deletions, observation };
}

/** One file as the conversation-level panel lists it: every record that
 *  saw it, under its root. */
export interface ChangedFile {
  path: string;
  entries: Array<{ record: AszWorkspaceChange; change: AszFileChange }>;
}

export interface ChangeRoot {
  root: string;
  files: ChangedFile[];
}

/** Records grouped by root, then by path, in document order. */
export function changeRoots(records: AszWorkspaceChange[]): ChangeRoot[] {
  const roots = new Map<string, Map<string, ChangedFile>>();
  for (const r of records) {
    const root = r.root?.path ?? '';
    let files = roots.get(root);
    if (!files) {
      files = new Map();
      roots.set(root, files);
    }
    for (const c of r.changes ?? []) {
      let f = files.get(c.path);
      if (!f) {
        f = { path: c.path, entries: [] };
        files.set(c.path, f);
      }
      f.entries.push({ record: r, change: c });
    }
  }
  return [...roots.entries()].map(([root, files]) => ({ root, files: [...files.values()] }));
}

export interface TalkRow {
  id: string;
  stream: string;
  label: string;
  reply: string;
  runs: number;
  steps: number;
  tools: number;
  from: number;
  to: number;
  child: boolean;
  segment: string;
}

/** A child stream a talk reaches: a call started it, or a notification said it
 *  finished. `back` marks the latter. */
export interface Folder {
  stream: AszStream;
  from: Step;
  quality: string;
  /** How many streams the same call started — a pool. */
  candidates: number;
  back: boolean;
}

/** Reading order is the order the records were written — the landed position,
 *  not the timestamp. A runtime stamps a whole batch at once and not always in
 *  write order; in one corpus a talk's opening human message carried a later
 *  millisecond than the six injections behind it, so sorting by time buried
 *  the line that starts the talk six cards down. */
export function readOrder(a: Step, b: Step): number {
  if (a.ref && b.ref) return a.ref.seq - b.ref.seq || a.ref.row - b.ref.row;
  return (a.at || 0) - (b.at || 0) || a.order - b.order;
}

export function timeOrder(a: Step, b: Step): number {
  return (a.at || 0) - (b.at || 0) || a.order - b.order;
}

export class ConversationModel {
  readonly talks: TalkRow[] = [];
  readonly talkById = new Map<string, TalkRow>();
  readonly streamByName = new Map<string, AszStream>();
  readonly streamById = new Map<string, AszStream>();
  readonly segmentById = new Map<string, AszSegment>();
  readonly stepById = new Map<string, Step>();
  /** Every step of a stream, in reading order. */
  private readonly stepsByStream = new Map<string, Step[]>();
  /** The same steps, in time order, for the axis. */
  private readonly flowByStream = new Map<string, Step[]>();
  private readonly talksByStream = new Map<string, TalkRow[]>();
  private readonly stepsByTalk = new Map<string, Step[]>();
  /** Steps outside any talk, per stream. */
  private readonly looseByStream = new Map<string, Step[]>();
  private readonly folderCache = new Map<string, Folder[]>();
  /** Steps that start or report a stream, keyed by the stream id. */
  private readonly openersByStreamId = new Map<string, Step[]>();
  /** Change records by the step they join to; the join is the record's
   *  `step`, never its id, which two producers share. */
  private readonly changesByStep = new Map<string, AszWorkspaceChange[]>();
  readonly workspaceChanges: AszWorkspaceChange[];

  constructor(readonly doc: AszViewDocument) {
    for (const s of doc.streams) {
      this.streamByName.set(s.name, s);
      this.streamById.set(s.id, s);
    }
    for (const seg of doc.segments) this.segmentById.set(seg.id, seg);
    this.workspaceChanges = doc.workspace_changes ?? [];
    for (const wc of this.workspaceChanges) if (wc.step) push(this.changesByStep, wc.step, wc);
    let order = 0;
    const flatten = (root: AszNode, talkId: string | null, streamFallback: string): void => {
      const walk = (n: AszNode, run: string | null, depth: number): void => {
        if (n.kind === 'run') run = n.id;
        if (!CONTAINER_KINDS.has(n.kind)) {
          const meta = kindOf(n.kind);
          const step: Step = {
            id: n.id,
            kind: n.kind,
            at: n.at,
            parent: n.parent,
            stream: n.stream || streamFallback,
            run,
            talk: talkId,
            track: meta.track,
            type: meta.type,
            name: n.name,
            text: n.text,
            state: n.state,
            bytes: n.bytes,
            result: n.result,
            resultState: n.result_state,
            resultBytes: n.result_bytes,
            durationMs: n.duration_ms,
            durationHow: n.duration_measured_by,
            reqToRes: n.request_to_result_ms,
            reqToResJoin: n.request_to_result_join,
            failed: n.failed,
            ref: n.ref,
            refs: n.refs,
            attrs: n.attrs,
            usage: n.usage,
            flags: n.flags,
            dropped: n.dropped,
            edges: n.edges ?? [],
            hasChanges: this.changesByStep.has(n.id),
            order: order++,
            depth,
          };
          this.stepById.set(step.id, step);
          push(this.stepsByStream, step.stream, step);
          if (talkId) push(this.stepsByTalk, talkId, step);
          else push(this.looseByStream, step.stream, step);
        }
        for (const k of n.children ?? []) walk(k, run, depth + 1);
      };
      walk(root, null, 0);
    };
    for (const t of doc.talks) {
      const row: TalkRow = {
        id: t.id,
        stream: t.stream ?? 'main',
        label: t.label ?? '',
        reply: t.reply ?? '',
        runs: t.runs ?? 0,
        steps: t.steps ?? 0,
        tools: t.tools ?? 0,
        from: t.from ?? 0,
        to: t.to ?? 0,
        child: !!t.child,
        segment: t.segment ?? '',
      };
      this.talks.push(row);
      this.talkById.set(row.id, row);
      push(this.talksByStream, row.stream, row);
      flatten(t, t.id, row.stream);
    }
    for (const n of doc.loose ?? []) flatten(n, null, n.stream ?? 'main');
    for (const [name, steps] of this.stepsByStream) {
      steps.sort(readOrder);
      this.flowByStream.set(name, [...steps].sort(timeOrder));
    }
    for (const steps of this.stepsByTalk.values()) steps.sort(readOrder);
    for (const steps of this.looseByStream.values()) steps.sort(readOrder);
    for (const step of this.stepById.values()) {
      for (const e of step.edges) {
        if (e.dir === 'out' && (e.type === 'starts' || e.type === 'reports') && this.streamById.has(e.other)) {
          push(this.openersByStreamId, e.other, step);
        }
      }
    }
  }

  get title(): string {
    return this.doc.summary.title;
  }

  /** Steps of a stream in reading order. */
  steps(stream: string): Step[] {
    return this.stepsByStream.get(stream) ?? [];
  }

  /** Steps of a stream in time order, for the axis. */
  flow(stream: string): Step[] {
    return this.flowByStream.get(stream) ?? [];
  }

  talksOf(stream: string): TalkRow[] {
    return this.talksByStream.get(stream) ?? [];
  }

  stepsOfTalk(talk: string): Step[] {
    return this.stepsByTalk.get(talk) ?? [];
  }

  loose(stream: string): Step[] {
    return this.looseByStream.get(stream) ?? [];
  }

  step(id: string | null | undefined): Step | null {
    return id ? (this.stepById.get(id) ?? null) : null;
  }

  /** The change records joined to a step, in document order. */
  changesOf(stepId: string): AszWorkspaceChange[] {
    return this.changesByStep.get(stepId) ?? [];
  }

  /** The streams the assembler could tie to the start or the end of a stream
   *  from THIS stream's steps. Several candidates for one call are all kept:
   *  the assembler did not choose, and neither does a view. */
  foldersFor(stream: string): Folder[] {
    const cached = this.folderCache.get(stream);
    if (cached) return cached;
    const seen = new Map<string, Folder>();
    const steps = this.steps(stream);
    for (const e of steps) {
      for (const g of e.edges) {
        if (g.dir !== 'out' || (g.type !== 'starts' && g.type !== 'reports')) continue;
        const st = this.streamById.get(g.other);
        if (!st) continue;
        const prev = seen.get(st.name);
        // A call is the better anchor than the notification that it finished.
        if (prev && !prev.back) continue;
        seen.set(st.name, { stream: st, from: e, quality: g.quality, candidates: 0, back: g.type === 'reports' });
      }
    }
    const calls = new Map<string, number>();
    for (const e of steps) {
      for (const g of e.edges) if (g.type === 'starts' && g.dir === 'out') calls.set(e.id, (calls.get(e.id) ?? 0) + 1);
    }
    const out = [...seen.values()];
    for (const f of out) f.candidates = calls.get(f.from.id) ?? 1;
    this.folderCache.set(stream, out);
    return out;
  }

  /** The step that opened a stream, from the stream's own `opened_by`. */
  openerOf(streamName: string): { step: Step; talk: string | null; quality: string } | null {
    const st = this.streamByName.get(streamName);
    const o = st?.opened_by?.[0];
    if (!o?.step) return null;
    const step = this.step(o.step);
    if (!step) return null;
    return { step, talk: o.talk || step.talk, quality: o.quality };
  }

  /** The streams a stream opened, for the "opens in turn" list. */
  openedBy(streamName: string): AszStream[] {
    return this.doc.streams.filter((x) => (x.opened_by ?? []).some((o) => o.stream === streamName));
  }

  /** The talk a step belongs to, walking up if the step is a container id. */
  talkOf(id: string): string | null {
    const s = this.step(id);
    if (s) return s.talk;
    return this.talkById.has(id) ? id : null;
  }

  /** The first talk of the main stream, else the first talk at all. */
  firstTalk(): TalkRow | null {
    return this.talks.find((t) => !t.child) ?? this.talks[0] ?? null;
  }

  /** Everything that has to do with a selection: the step, what a relation
   *  joins it to, its owner, and what it owns. Null means nothing is picked and
   *  nothing fades. */
  relatedTo(sel: string | null, folder: string | null, streamSteps: Step[]): Set<string> | null {
    if (!sel) return null;
    if (folder) return new Set([sel]);
    const here = this.step(sel);
    if (!here) return null;
    const set = new Set<string>([sel]);
    for (const r of here.edges) set.add(r.other);
    if (here.parent) set.add(here.parent);
    for (const e of streamSteps) if (e.parent === sel) set.add(e.id);
    return set;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** A value from a node's `attrs`, as a string. */
export function attrString(attrs: Record<string, unknown> | undefined, key: string): string {
  const v = attrs?.[key];
  return typeof v === 'string' ? v : '';
}
