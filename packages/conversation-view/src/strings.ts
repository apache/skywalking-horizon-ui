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
 * Every piece of text the renderer shows, in English. A host that translates
 * its chrome passes its own values; a host that does not gets these. Keys are
 * stable identifiers, not the English itself, so a host's catalog survives a
 * rewording here.
 *
 * Node kinds, relation types, qualities and states from the document are NOT
 * here: they are the model's vocabulary and are shown as the document says
 * them, the same in every language, so a reader can grep them in the
 * Sessionizer's docs.
 */
export interface ViewStrings {
  // Status strip and overview
  round: string;
  segments: string;
  streams: string;
  talks: string;
  span: string;
  unresolved: string;
  overview: string;
  session: string;
  steps: string;
  runs: string;
  childStreams: string;
  childStreamsNote: string;
  relations: string;
  activityWindows: string;
  idle: string;
  integrityVerified: string;
  integrityIncomplete: string;
  integrityMismatch: string;
  problems: string;
  roundsVerified: string;
  filesListed: string;
  filterTalks: string;
  noTalkMatches: string;
  untitled: string;
  // Transcript
  talk: string;
  mainStreamCaption: string;
  childStreamCaption: string;
  tools: string;
  externalInput: string;
  noOpeningLine: string;
  delegatedWork: string;
  showWork: string;
  hideWork: string;
  quiet: string;
  mainAgent: string;
  childAgent: string;
  agent: string;
  response: string;
  streamOutput: string;
  clientMadeMessage: string;
  contextPutIn: string;
  agentCallToChild: string;
  notificationFromChild: string;
  launchAcknowledged: string;
  modelCall: string;
  reasoning: string;
  toolWord: string;
  callWord: string;
  turn: string;
  input: string;
  result: string;
  failed: string;
  toReturn: string;
  openStream: string;
  independentStream: string;
  openedFrom: string;
  noOpenerRecorded: string;
  backToOpener: string;
  noTalksInStream: string;
  outsideAnyTalk: string;
  outsideAnyTalkNote: string;
  childStreamsPick: string;
  childStreamSingular: string;
  childStreamPlural: string;
  backToStream: string;
  showThisTalk: string;
  showThisAnswer: string;
  locateInTimeline: string;
  // Timeline
  flowTimeline: string;
  timelineHelp: string;
  parentTimeline: string;
  fadeUnrelated: string;
  fadeUnrelatedTitle: string;
  zoom: string;
  centerSelected: string;
  centerSelectedTitle: string;
  events: string;
  nested: string;
  laneInput: string;
  laneResponses: string;
  laneContext: string;
  laneModel: string;
  laneTools: string;
  laneAgents: string;
  laneNotices: string;
  laneNested: string;
  legendInput: string;
  legendResponse: string;
  legendModel: string;
  legendTool: string;
  legendAgent: string;
  legendContext: string;
  legendOwns: string;
  legendExact: string;
  legendInferred: string;
  agentsCreated: string;
  poolTitle: string;
  reportedHere: string;
  clickToSeeOpener: string;
  helpWhat: string;
  helpWhatText: string;
  helpHeading: string;
  helpHeadingText: string;
  helpAxis: string;
  helpAxisText: string;
  helpLinks: string;
  helpLinksText: string;
  helpFade: string;
  helpFadeText: string;
  // Inspector
  inspector: string;
  details: string;
  evidence: string;
  selectAStep: string;
  nestedStream: string;
  stream: string;
  role: string;
  openedBy: string;
  reportedHereBy: string;
  note: string;
  reportedNote: string;
  joinQuality: string;
  openedAt: string;
  itsAnswer: string;
  itsAnswerNote: string;
  opensInTurn: string;
  opensNothing: string;
  andMore: string;
  poolWarning: string;
  poolWarningText: string;
  diveIn: string;
  diveHint: string;
  nodeKind: string;
  lane: string;
  segment: string;
  run: string;
  directParent: string;
  observedAt: string;
  requestToResult: string;
  duration: string;
  durationUnavailable: string;
  requestToResultWhat: string;
  requestToResultText: string;
  name: string;
  failedField: string;
  yes: string;
  no: string;
  contentState: string;
  contentBytes: string;
  tokens: string;
  tokensText: string;
  contentUnavailable: string;
  contentUnavailableText: string;
  oneChildAgent: string;
  childAgents: string;
  openRelations: string;
  backToParentStream: string;
  noRelation: string;
  agentsCreatedByCall: string;
  agentsCreatedText: string;
  outgoing: string;
  incoming: string;
  joinedOn: string;
  namedFromJournal: string;
  otherEndOutside: string;
  derivedByAssembly: string;
  landedPositions: string;
  request: string;
  part: string;
  record: string;
  clippedText: string;
  fullTextNote: string;
  loadFullRecord: string;
  loadingRecord: string;
  recordFailed: string;
  theLandedRecord: string;
  dropped: string;
  flags: string;
  unavailable: string;
  // Glossary explanations
  vocabulary: string;
  modelOwnWord: string;
  aszTerm: string;
  runtimeWord: string;
  runtimeNoWord: string;
  whereToLook: string;
  nowhereInSource: string;
  readCarefully: string;
  dialect: string;
  landedRecordField: string;
  aszField: string;
  whatItIs: string;
  notApplicable: string;
  close: string;
  whatDoesMean: string;
  // Announcements
  selected: string;
  selectedNestedStream: string;
  selectionCleared: string;
}

export const ENGLISH: ViewStrings = {
  round: 'round',
  segments: 'segments',
  streams: 'streams',
  talks: 'talks',
  span: 'span',
  unresolved: 'unresolved',
  overview: 'Overview',
  session: 'Session',
  steps: 'Steps',
  runs: 'runs',
  childStreams: 'Child streams',
  childStreamsNote: 'subagents, each its own context',
  relations: 'Relations',
  activityWindows: 'activity windows',
  idle: 'idle',
  integrityVerified: 'verified',
  integrityIncomplete: 'incomplete',
  integrityMismatch: 'mismatch',
  problems: 'problems',
  roundsVerified: 'rounds verified',
  filesListed: 'files',
  filterTalks: 'filter',
  noTalkMatches: 'No talk matches.',
  untitled: '(untitled)',
  talk: 'Talk',
  mainStreamCaption: 'main stream, child work folded',
  childStreamCaption: 'child stream',
  tools: 'tools',
  externalInput: 'External · Input',
  noOpeningLine: 'no opening line',
  delegatedWork: 'delegated work',
  showWork: 'show what the agent did',
  hideWork: 'hide what the agent did',
  quiet: 'quiet',
  mainAgent: 'Main agent',
  childAgent: 'Child agent',
  agent: 'Agent',
  response: 'Response',
  streamOutput: 'Stream output',
  clientMadeMessage: 'Client-made message · not from the provider',
  contextPutIn: 'Context put in',
  agentCallToChild: 'Agent call',
  notificationFromChild: 'Runtime notification',
  launchAcknowledged: 'Launch acknowledged',
  modelCall: 'Model call',
  reasoning: 'Reasoning',
  toolWord: 'Tool',
  callWord: 'call',
  turn: 'turn',
  input: 'input',
  result: 'result',
  failed: 'failed',
  toReturn: 'to return',
  openStream: 'Open',
  independentStream: 'Independent stream context. Its messages are not merged into the parent.',
  openedFrom: 'Opened from',
  noOpenerRecorded: 'No relation records what opened it.',
  backToOpener: '← Back to the step that opened this',
  noTalksInStream: 'No talks in this stream.',
  outsideAnyTalk: 'Outside any talk',
  outsideAnyTalkNote: 'Steps the fold could not place under a talk — a child’s output whose stream opened no talk, for instance. The document holds them so nothing is lost.',
  childStreamsPick: 'child streams…',
  childStreamSingular: 'child stream',
  childStreamPlural: 'child streams',
  backToStream: 'Back to',
  showThisTalk: 'Show this talk in the flow timeline',
  showThisAnswer: 'Show this talk’s answer in the flow timeline',
  locateInTimeline: 'Locate in the flow timeline',
  flowTimeline: 'Flow timeline',
  timelineHelp: 'What is the flow timeline?',
  parentTimeline: '← Parent timeline',
  fadeUnrelated: 'Fade unrelated',
  fadeUnrelatedTitle: 'Fade the steps that the selected one does not touch',
  zoom: 'Zoom',
  centerSelected: 'Center selected',
  centerSelectedTitle: 'Scroll the timeline to the selected step',
  events: 'events',
  nested: 'nested',
  laneInput: 'External input',
  laneResponses: 'Responses',
  laneContext: 'Context put in',
  laneModel: 'Model calls',
  laneTools: 'Tools',
  laneAgents: 'Agent activity',
  laneNotices: 'Runtime notices',
  laneNested: 'Nested streams',
  legendInput: 'External input',
  legendResponse: 'Agent response',
  legendModel: 'Model call',
  legendTool: 'Tool',
  legendAgent: 'Agent / nested stream',
  legendContext: 'Context / annotation',
  legendOwns: 'Emitted by (ownership)',
  legendExact: 'Exact join',
  legendInferred: 'Strong inference',
  agentsCreated: 'agents created',
  poolTitle: 'This call started {n} child agents at nearly the same moment. Click, then pick one in the inspector.',
  reportedHere: 'It reported finishing in this talk.',
  clickToSeeOpener: 'Click to see what opened it.',
  helpWhat: 'what it shows',
  helpWhatText:
    'One talk, on a time axis. Each row is a lane: the messages, the model calls, the tools it ran, its agent activity, and the nested streams it started. The line above the lanes is the whole conversation, one cell per segment.',
  helpHeading: 'the heading',
  helpHeadingText: 'Which stream the lanes belong to, how many steps are in this talk, and how many nested streams it touches.',
  helpAxis: 'the axis',
  helpAxisText: 'Busy stretches take the width. A long pause is cut to a short gap marked with how long it was, so a talk with an hour of waiting still reads.',
  helpLinks: 'links',
  helpLinksText:
    'The lines between lanes, drawn for the step you select. A solid line is an exact join, a dashed one was inferred, and a faint curve is ownership: the model call that produced a step.',
  helpFade: 'fade unrelated',
  helpFadeText: 'After you click a step, fade everything it does not touch.',
  inspector: 'Inspector',
  details: 'Details',
  evidence: 'Evidence',
  selectAStep: 'Select a step.',
  nestedStream: 'nested stream',
  stream: 'Stream',
  role: 'Role',
  openedBy: 'Opened by',
  reportedHereBy: 'Reported here by',
  note: 'Note',
  reportedNote: 'this talk hears the ending. The call that started it is in an earlier talk, because a launch and its completion land in different turns.',
  joinQuality: 'Join quality',
  openedAt: 'Opened at',
  itsAnswer: 'Its answer',
  itsAnswerNote: 'not in this stream. A child’s output belongs to the child, so the parent holds a boundary that refers to it, never a copy. Dive in to read it.',
  opensInTurn: 'Opens in turn',
  opensNothing: 'nothing — it opened no stream of its own',
  andMore: 'and {n} more',
  poolWarning: 'this call started {n} streams',
  poolWarningText: 'A workflow call starts a run, and the run starts a pool of agents. They are all its children, not competing guesses at one child.',
  diveIn: 'Dive in →',
  diveHint: 'Enter to dive in · Escape to clear',
  nodeKind: 'Node kind',
  lane: 'Lane',
  segment: 'Segment',
  run: 'Run',
  directParent: 'Direct parent',
  observedAt: 'Observed at',
  requestToResult: 'Request to result',
  duration: 'Duration',
  durationUnavailable: 'unavailable — the runtime does not report how long this ran',
  requestToResultWhat: 'What "request to result" is',
  requestToResultText:
    'The time between the record carrying the request and the record carrying the result. An exact identifier ties those two records together, so the interval belongs to this call. It is not how long the tool ran, and the runtime does not report that.',
  name: 'Name',
  failedField: 'Failed',
  yes: 'yes',
  no: 'no',
  contentState: 'Content state',
  contentBytes: 'Content bytes',
  tokens: 'Tokens',
  tokensText: 'in {in} · out {out} · cache read {cacheRead} · cache write {cacheWrite}',
  contentUnavailable: 'Content {state}',
  contentUnavailableText: 'The source did not supply readable content for this step. It is reported as it was found, not filled in.',
  oneChildAgent: '1 child agent',
  childAgents: '{n} child agents',
  openRelations: 'open the Relations tab →',
  backToParentStream: '← Back to parent stream',
  noRelation: 'No relation touches this step.',
  agentsCreatedByCall: '{n} agents created by this call',
  agentsCreatedText: 'A workflow call starts a run, and the run starts a pool of agents. Every one of them is a child of this call, not a competing guess at one child. Pick the one to read.',
  outgoing: 'outgoing',
  incoming: 'incoming',
  joinedOn: 'joined on',
  namedFromJournal: 'named from its run journal',
  otherEndOutside: 'the other end is outside this stream',
  derivedByAssembly: 'This step was derived by assembly. It cites no landed record.',
  landedPositions: 'landed positions',
  request: 'request',
  part: 'part',
  record: 'record',
  clippedText: 'the text as the document carries it',
  fullTextNote: 'clipped: {shown} of {total} bytes',
  loadFullRecord: 'Load the landed record',
  loadingRecord: 'reading…',
  recordFailed: 'The record could not be read.',
  theLandedRecord: 'the landed record',
  dropped: 'dropped',
  flags: 'flags',
  unavailable: 'unavailable',
  vocabulary: 'vocabulary',
  modelOwnWord: 'the model’s own word',
  aszTerm: 'asz term',
  runtimeWord: 'runtime word',
  runtimeNoWord: 'none — this is derived here, the runtime has no word for it',
  whereToLook: 'where to look',
  nowhereInSource: 'nowhere in the source; it is produced by assembly',
  readCarefully: 'read it carefully',
  dialect: 'dialect',
  landedRecordField: 'a field of the landed record',
  aszField: 'asz field',
  whatItIs: 'what it is',
  notApplicable: 'not applicable — this describes the landed record, not the source',
  close: 'Close',
  whatDoesMean: 'What does {key} mean?',
  selected: 'Selected {what}',
  selectedNestedStream: 'Selected nested stream {name}, opened by {kind}. Press Enter to dive in, Escape to clear.',
  selectionCleared: 'Selection cleared.',
};

/** `{name}` placeholders, filled from `vars`. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}
