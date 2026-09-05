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

import type { ConversationModel, TalkRow } from '../model.js';
import type { ViewStrings } from '../strings.js';
import type { TimeFormatter } from '../format.js';
import type { AszRef, Glossary, LandedRecord } from '../types.js';

export type InspectorTab = 'details' | 'relations' | 'evidence';

/** What the reader is looking at. The three fields a host round-trips through
 *  its URL are the talk, the selected step and the stream; the rest is local. */
export interface ViewState {
  talk: TalkRow | null;
  stream: string | null;
  sel: string | null;
  /** A nested stream picked on the timeline — not entered, only pointed at. */
  folder: string | null;
  rawRef: AszRef | null;
  zoom: number;
  focus: boolean;
  /** Whether the selection was the reader's, or the default a talk opens with.
   *  Only a reader's pick fades the rest. */
  picked: boolean;
  tab: InspectorTab;
  navStack: Array<{ stream: string; sel: string | null }>;
  openTalks: Set<string>;
  autoOpen: Set<string>;
  explain: string | null;
  overviewOpen: boolean;
}

/** Everything a view module needs: the model, the words, the state, and the
 *  actions the entry point implements over them. */
export interface ViewContext {
  root: HTMLElement;
  model: ConversationModel;
  s: ViewStrings;
  f: TimeFormatter;
  glossary: Glossary | null;
  loadRecord?: (ref: AszRef) => Promise<LandedRecord>;
  state: ViewState;
  q<T extends Element = HTMLElement>(selector: string): T;

  select(id: string, center: boolean, alsoTranscript?: boolean): void;
  selectFolder(name: string): void;
  clearSelection(): void;
  clearFolder(): void;
  diveIn(): void;
  goBack(): void;
  goToOpener(stream: string, step: string, talk: string | null): void;
  openTalk(id: string, keepStack?: boolean): void;
  focusTalk(id: string, end?: string): void;
  switchStream(name: string): void;
  showTab(tab: InspectorTab): void;
  renderAll(recenter?: boolean): void;
  drawTimeline(): void;
  drawTranscript(): void;
  drawInspector(): void;
  drawStreamTabs(): void;
  drawTalkList(): void;
  centerOn(id: string | null, behavior: ScrollBehavior, alsoTranscript?: boolean): void;
  announce(text: string): void;
}

/** A stream's display name: the main agent, or a child's label, or a short id. */
export function streamName(ctx: ViewContext, name: string): string {
  const st = ctx.model.streamByName.get(name);
  if (!st) return name;
  if (st.role === 'main') return ctx.s.mainAgent;
  return st.label || `${ctx.s.childStreamSingular} ${st.name.slice(0, 6)}`;
}
