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
 * The `asz.view` 1.0 document, as the AI Sessionizer defines it in
 * `pkg/sessionview` and the OAP reproduces it key for key. Keys are
 * `snake_case` as on the wire. A 1.x adds keys and never removes one, so
 * every field below is what version 1.0 carries and a reader tolerates more.
 */

export interface AszRef {
  seq: number;
  row: number;
  block?: number;
}

export interface AszUsage {
  in?: number;
  out?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface AszDrop {
  what: string;
  bytes: number;
  why?: string;
}

export interface AszEdge {
  type: string;
  other: string;
  dir: 'out' | 'in';
  quality: string;
  via?: string;
}

/** One node of a talk tree: a talk, a run, or a step. Keys a node has no value
 *  for are absent, not null. */
export interface AszNode {
  id: string;
  kind: string;
  parent?: string;
  stream?: string;
  /** Epoch ms; 0 when nothing observed a time. */
  at: number;
  ref?: AszRef;
  refs?: AszRef[];
  attrs?: Record<string, unknown>;
  /** Readable text of the part the node stands on, clipped to 2,000 bytes. */
  text?: string;
  state?: string;
  /** Full size of the part, so a viewer can say how much of it `text` is. */
  bytes?: number;
  usage?: AszUsage;
  flags?: string[];
  dropped?: AszDrop[];
  // A talk adds these.
  label?: string;
  reply?: string;
  runs?: number;
  steps?: number;
  tools?: number;
  from?: number;
  to?: number;
  child?: boolean;
  segment?: string;
  // A tool or agent call adds these.
  name?: string;
  failed?: boolean;
  result?: string;
  result_state?: string;
  result_bytes?: number;
  request_to_result_ms?: number;
  request_to_result_join?: string;
  // A turn.duration step adds these.
  duration_ms?: number;
  duration_measured_by?: string;
  children?: AszNode[];
  edges?: AszEdge[];
}

export interface AszOrigin {
  step: string;
  stream: string;
  talk: string;
  quality: string;
}

export interface AszStream {
  id: string;
  name: string;
  role: 'main' | 'child' | string;
  label: string;
  parent: string;
  records: number;
  steps: number;
  talk: string;
  named_by: string;
  opened_by: AszOrigin[];
}

export interface AszSegment {
  id: string;
  state: string;
  committable: boolean;
  talks: number;
  from: number;
  to: number;
}

export interface AszRound {
  round: number;
  digest: string;
  previous: string | null;
  from_seq: number;
  through_seq: number;
  input_digest: string;
  from_time: number | null;
  through_time: number | null;
  verified: boolean;
}

export interface AszFile {
  file: string;
  format: 'sd' | 'sf' | string;
  kind: string;
  seq: number | null;
  round: number | null;
  stream: string | null;
  run: string | null;
  lines: number;
  bytes: number;
  digest: string;
  from_time: number | null;
  through_time: number | null;
}

export interface AszRelation {
  id: string;
  type: string;
  from: string;
  to: string;
  quality: string;
  via?: string;
  evidence?: AszRef[];
}

export interface AszUnresolved {
  id: string;
  kind: string;
  ref: string;
  reason: string;
  state: string;
}

export type AszIntegrityState = 'verified' | 'incomplete' | 'mismatch' | string;

export interface AszSummary {
  title: string;
  state: AszIntegrityState;
  problems: string[];
  talks: number;
  steps: number;
  streams: number;
  segments: number;
  rounds: number;
  unresolved: number;
  from: number;
  to: number;
  kinds: Record<string, number>;
  relation_types: Record<string, number>;
  quality: Record<string, number>;
}

export interface AszViewDocument {
  format: string;
  version: string;
  conversation: string;
  sessions: string[];
  head: { round: number; digest: string };
  parser: string;
  policy: string;
  summary: AszSummary;
  rounds: AszRound[];
  files: AszFile[];
  streams: AszStream[];
  segments: AszSegment[];
  talks: AszNode[];
  loose?: AszNode[];
  relations: AszRelation[];
  unresolved: AszUnresolved[];
}

export const ASZ_VIEW_FORMAT = 'asz.view';
export const ASZ_VIEW_MAJOR_VERSION = 1;

/** Whether a parsed value is a document this renderer can draw: the format
 *  name, and a major version it knows. A reader that meets another major
 *  version stops here, as the format page instructs. */
export function isSupportedDocument(v: unknown): v is AszViewDocument {
  if (!v || typeof v !== 'object') return false;
  const d = v as { format?: unknown; version?: unknown; talks?: unknown };
  if (d.format !== ASZ_VIEW_FORMAT || typeof d.version !== 'string') return false;
  const major = Number(d.version.split('.')[0]);
  return major === ASZ_VIEW_MAJOR_VERSION && Array.isArray(d.talks);
}

/** A landed record, as a host that can read one by address returns it. The
 *  renderer prints it as JSON; it interprets nothing but `dropped`. */
export interface LandedRecord {
  dropped?: AszDrop[];
  [key: string]: unknown;
}

/** What the runtime calls each name the model uses, and what each landed-record
 *  field means — as the Sessionizer's `/api/glossary` serves it. Optional: a
 *  host without one (the OAP has none) shows the names and no explanations. */
export interface Glossary {
  dialect: string;
  terms: Record<string, { native?: string; where?: string; note?: string }>;
  fields: Record<string, string>;
}
