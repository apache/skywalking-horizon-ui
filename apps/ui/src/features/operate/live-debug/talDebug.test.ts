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

import { describe, expect, it } from 'vitest';
import type { SessionRecord, SessionResponse, TalRun } from '@skywalking-horizon-ui/api-client';
import type { TalLineVar } from './talDebug';
import {
  displayValue,
  dslOffsetIn,
  lineVariables,
  localsOf,
  paneFieldOf,
  ruleNameOf,
  stepResult,
  lineValues,
  outputInline,
  outputLinks,
  outputDisplay,
  timeText,
  stepLines,
  dslAt,
  outputSummary,
  ruleRange,
  spanLabel,
  talCaptureCounts,
  talRecordViews,
} from './talDebug';

// Cut from a native-rpc-entry capture: the segment's exit span aborts in the
// filter, its entry span runs on and sends a Service source.
const abortRun: TalRun = {
  continueOn: false,
  reason: 'abort {} at line 34',
  steps: [
    { stage: 'filter', kind: 'if', sourceLine: 33, sourceText: 'if (…)', result: true },
    { stage: 'filter', kind: 'abort', sourceLine: 34, sourceText: 'abort {}' },
  ],
  outputs: [],
  state: { segmentDefs: {} },
};

const entryRun: TalRun = {
  continueOn: true,
  steps: [
    { stage: 'filter', kind: 'if', sourceLine: 33, sourceText: 'if (…)', result: false },
    { stage: 'extractor', kind: 'block', sourceLine: 36, sourceText: 'extractor {' },
    { stage: 'extractor', kind: 'def', sourceLine: 45, sourceText: 'def latency = …', value: 1255 },
    { stage: 'extractor', kind: 'source', sourceLine: 282, sourceText: 'source Service {', output: 0 },
  ],
  outputs: [{ kind: 'source', sourceLine: 282, scope: 'Service', fields: { name: 'e2e-service-consumer' } }],
  state: { segmentDefs: {} },
};

const segment = (captureTime: string): SessionRecord => ({
  startedAtMs: 1,
  captureTime,
  dsl: 'filter {\n  if (…) {\n',
  rule: { ruleName: 'native-rpc-entry', file: 'native-rpc.yaml' },
  context: { kind: 'segment' },
  spans: [
    { span: { spanId: 1, spanType: 'Exit', operationName: '/users', spanLayer: 'Http', peer: 'provider:9090' }, run: abortRun },
    { span: { spanId: 0, spanType: 'Entry', operationName: 'POST:/users', spanLayer: 'Http' }, run: entryRun },
    { span: { spanId: 2, spanType: 'Local', operationName: 'never' } },
  ],
});

const otlp = (captureTime: string): SessionRecord => ({
  startedAtMs: 1,
  captureTime,
  dsl: '',
  rule: { ruleName: 'otlp-general' },
  context: { kind: 'span' },
  spans: [{ span: { name: 'openai.chat', kind: 'SPAN_KIND_CLIENT' }, run: abortRun }],
});

const session = (nodes: SessionResponse['nodes']): SessionResponse => ({ sessionId: 's', capturedAt: 1, nodes });

describe('talRecordViews', () => {
  it('gives each span of a segment a frame, the run-less one included, and orders records by capture time', () => {
    const views = talRecordViews(
      session([
        { nodeId: 'n', status: 'ok', records: [segment('2.000000')] },
        { nodeId: 'n', peer: 'oap2:17129', status: 'ok', records: [otlp('1.000000')] },
      ]),
    );
    expect(views.map((v) => v.key)).toEqual(['peer:oap2:17129#1', 'node:n#1']);
    expect(views[1]!.frames.map((f) => f.run !== null)).toEqual([true, true, false]);
  });
});

describe('talCaptureCounts', () => {
  it('counts records by kind, the spans a segment carries against those the rule ran on, stopped runs and outputs', () => {
    const counts = talCaptureCounts(
      session([{ nodeId: 'n', status: 'captured', captured: true, records: [segment('1.000000'), otlp('1.000001')] }]),
    );
    expect(counts).toMatchObject({
      records: 2,
      segments: 1,
      segmentSpans: 3,
      segmentSpansRun: 2,
      otlpSpans: 1,
      stopped: 2,
      outputs: { source: 1 },
    });
    expect(counts.nodes).toEqual([{ nodeKey: 'node:n', nodeLabel: 'n', status: 'captured', records: 2, captured: true }]);
  });

  it('counts an oversized stub without reading into it', () => {
    const stub: SessionRecord = { startedAtMs: 1, dsl: '', rule: { ruleName: 'r' }, oversizedBytes: 9 };
    expect(talCaptureCounts(session([{ nodeId: 'n', status: 'ok', records: [stub] }])).oversized).toBe(1);
  });
});

describe('lineValues', () => {
  it('leaves each executed line its value and marks the abort and the output lines', () => {
    const aborted = lineValues(abortRun, null);
    expect(aborted.get(33)).toMatchObject({ text: 'true', marker: null });
    expect(aborted.get(34)).toMatchObject({ text: 'abort', marker: 'abort' });

    const ran = lineValues(entryRun, null);
    expect(ran.get(45)?.text).toBe('1255');
    expect(ran.get(36)?.text).toBe('entered');
    expect(ran.get(282)).toMatchObject({ text: '→ source Service', marker: 'output' });
    expect(ran.has(34)).toBe(false);
  });

  it('shows each operand an if evaluated, then what the condition decided', () => {
    const run: TalRun = {
      continueOn: true,
      steps: [
        {
          stage: 'filter',
          kind: 'if',
          sourceLine: 58,
          sourceText: 'if (meta.kind == "CONSUMER" && meta.root)',
          operands: [{ text: 'meta.kind', value: 'SERVER' }],
          result: false,
        },
      ],
      outputs: [],
    };
    expect(lineValues(run, null).get(58)?.text).toBe('meta.kind = "SERVER" → false');
  });

  it('folds a line run many times with one value into a count', () => {
    const run: TalRun = {
      continueOn: true,
      steps: [1, 2, 3].map(() => ({ stage: 'extractor', kind: 'foreach', sourceLine: 9, sourceText: 'foreach', value: 'x' })),
      outputs: [],
    };
    expect(lineValues(run, null).get(9)?.text).toBe('"x" ×3');
  });

  it('moves a DSL line into the file by the offset of the rule’s DSL', () => {
    const run: TalRun = { continueOn: true, steps: [{ stage: 'filter', kind: 'abort', dslLine: 2, sourceText: 'abort {}' }], outputs: [] };
    expect([...lineValues(run, 30).keys()]).toEqual([32]);
  });
});

describe('dslOffsetIn / ruleRange', () => {
  it('finds the rule’s DSL in its file, whatever the YAML indent', () => {
    const file = ['rules:', '  - name: a', '    dsl: |', '      filter {', '        abort {}', '      }'];
    const offset = dslOffsetIn(file, 'filter {\n  abort {}\n}\n');
    expect(offset).toBe(3);
    expect(ruleRange('filter {\n  abort {}\n}\n', offset)).toEqual({ first: 4, last: 6 });
    expect(dslOffsetIn(file, 'source X {\n')).toBeNull();
  });
});

describe('labels', () => {
  it('names a native span by type, operation, layer and peer, and an OTLP span by kind and name', () => {
    expect(spanLabel(segment('1').spans![0]!)).toBe('Exit /users · Http → provider:9090');
    expect(spanLabel(otlp('1').spans![0]!)).toBe('client openai.chat');
  });

  it('links each output to the statement that sent it, or to its line when no step names it', () => {
    const run: TalRun = {
      continueOn: true,
      steps: [
        { stage: 'extractor', kind: 'metrics', sourceLine: 90, sourceText: 'metrics {', output: 0 },
        { stage: 'extractor', kind: 'pairing', sourceLine: 170, sourceText: 'buildNetworkAlias …', output: 2 },
      ],
      outputs: [
        { kind: 'metrics', sourceLine: 90, metric: 'otlp_service_cpm' },
        { kind: 'persist', sourceLine: 40, vote: 'keep' },
        { kind: 'pairing', sourceLine: 170, role: 'callee', outcome: 'notSampled' },
      ],
    };
    expect(outputLinks(run, null).map((l) => [l.name, l.line, l.step])).toEqual([
      ['otlp_service_cpm', 90, 0],
      ['keep', 40, null],
      ['callee notSampled', 170, 1],
    ]);
  });

  it('names an output by what it sent', () => {
    expect(outputInline({ kind: 'metrics', metric: 'm1' })).toBe('metrics m1');
    expect(outputInline({ kind: 'pairing', role: 'caller', outcome: 'sent' })).toBe('pairing caller sent');
    expect(outputInline({ kind: 'persist', vote: 'keep' })).toBe('persist keep');
  });
});

describe('displayValue', () => {
  it('reads native tags and OTLP attributes as maps, keeping every value of a repeated key', () => {
    expect(displayValue([{ key: 'url', value: '/a' }, { key: 'db', value: 'x' }, { key: 'db', value: 'y' }])).toEqual({
      url: '/a',
      db: ['x', 'y'],
    });
    expect(
      displayValue([
        { key: 'gen_ai.request.model', value: { stringValue: 'gpt' } },
        { key: 'gen_ai.is_streaming', value: { boolValue: false } },
        { key: 'list', value: { arrayValue: { values: [{ intValue: '1' }, { intValue: '2' }] } } },
      ]),
    ).toEqual({ 'gen_ai.request.model': 'gpt', 'gen_ai.is_streaming': false, list: ['1', '2'] });
  });

  it('leaves other lists and values alone', () => {
    expect(displayValue([1, { a: 2 }])).toEqual([1, { a: 2 }]);
    expect(displayValue({ refs: [], spanId: 0 })).toEqual({ refs: [], spanId: 0 });
  });
});

describe('outputSummary', () => {
  it('reads a metric as where it lands and its value, and a skipped one by its reason', () => {
    expect(
      outputSummary({ kind: 'metrics', metric: 'm', entity: { scope: 'ENDPOINT', service: 's', endpoint: 'GET /a' }, observation: 12 }),
    ).toBe('ENDPOINT s GET /a = 12');
    expect(outputSummary({ kind: 'metrics', skipped: 'layer not registered' })).toBe('skipped: layer not registered');
  });
});

describe('lineVariables', () => {
  const file = [
    '      if (meta.kind == "SERVER" || meta.kind == "CONSUMER") {',
    '        def latency = (span.endTime - span.startTime) as Integer',
    '        type = "HTTP" as RequestType',
    '      if (meta.kind == "CONSUMER" && meta.root',
    '          && attr("messaging.operation.type") == "receive") {',
  ];
  const textOf = (line: number): string | undefined => file[line - 1];

  it('places each operand an if evaluated, a name written twice at its next place, and spans the condition’s lines', () => {
    const run: TalRun = {
      continueOn: true,
      steps: [
        {
          stage: 'filter',
          kind: 'if',
          sourceLine: 1,
          sourceText: 'if (…)',
          operands: [
            { text: 'meta.kind', value: 'CLIENT' },
            { text: 'meta.kind', value: 'CLIENT' },
          ],
          result: false,
        },
        {
          stage: 'filter',
          kind: 'if',
          sourceLine: 4,
          sourceText: 'if (meta.kind == "CONSUMER" && meta.root\n && attr(…) == "receive")',
          operands: [
            { text: 'meta.kind', value: 'CONSUMER' },
            { text: 'meta.root', value: true },
            { text: 'attr("messaging.operation.type")', value: 'receive' },
          ],
          result: true,
        },
      ],
      outputs: [],
    };
    const vars = lineVariables(run, 1, null, textOf);
    expect(vars.get(1)?.map((v) => [v.name, v.start])).toEqual([
      ['meta.kind', 10],
      ['meta.kind', 35],
    ]);
    expect(vars.get(4)?.map((v) => v.name)).toEqual(['meta.kind', 'meta.root']);
    expect(vars.get(5)?.map((v) => [v.name, v.value])).toEqual([['attr("messaging.operation.type")', 'receive']]);
  });

  it('places the name a def or an assignment sets, and only for the steps reached', () => {
    const run: TalRun = {
      continueOn: true,
      steps: [
        { stage: 'extractor', kind: 'def', sourceLine: 2, sourceText: 'def latency = …', value: 1255 },
        { stage: 'extractor', kind: 'assign', sourceLine: 3, sourceText: 'type = "HTTP" as RequestType', value: 'HTTP' },
      ],
      outputs: [],
    };
    expect(lineVariables(run, 1, null, textOf).get(2)).toEqual([
      { name: 'latency', value: 1255, line: 2, start: 12, end: 19, step: 0, local: true },
    ]);
    expect(lineVariables(run, 1, null, textOf).get(3)?.[0]?.name).toBe('type');
    expect(lineVariables(run, 0, null, textOf).has(3)).toBe(false);
  });
});

describe('stepResult', () => {
  it('reads an if by its result and an output by what it sent, and leaves a def to its variable', () => {
    expect(stepResult({ stage: 'filter', kind: 'if', result: false }, [])).toEqual({ label: 'result', value: false });
    expect(
      stepResult({ stage: 'extractor', kind: 'metrics', output: 0 }, [
        { kind: 'metrics', sourceLine: 90, metric: 'm', observation: 1 },
      ]),
    ).toEqual({ label: '→ metrics m', value: { metric: 'm', value: 1 } });
    expect(stepResult({ stage: 'extractor', kind: 'def', value: 1 }, [])).toBeNull();
  });
});

describe('the shared selection between the rule file and the variables pane', () => {
  const v = (name: string, value: unknown, step: number, local: boolean): TalLineVar => ({
    name,
    value,
    line: step + 1,
    start: 0,
    end: name.length,
    step,
    local,
  });

  it('keeps each name the rule set at its latest value, and leaves out what it only read', () => {
    const vars = new Map<number, TalLineVar[]>([
      [1, [v('svc', 'a', 0, true)]],
      [2, [v('meta.kind', 'SERVER', 1, false)]],
      [3, [v('svc', 'b', 2, true)]],
    ]);
    expect(localsOf(vars)).toEqual({ svc: { value: 'b', line: 3, step: 2 } });
  });

  it('maps a name the rule reads to its field in the pane, and back', () => {
    const locals = { svc: { value: {}, line: 1, step: 0 } };
    expect(paneFieldOf('meta.kind', locals)).toBe('meta.kind');
    expect(paneFieldOf('span.operationName', locals)).toBe('span.operationName');
    expect(paneFieldOf('attr("http.route")', locals)).toBe('span.attributes');
    expect(paneFieldOf('hasAttr("k", "j")', locals)).toBe('span.attributes');
    expect(paneFieldOf('svc', locals)).toBe('locals.svc');
    expect(paneFieldOf('unknown', locals)).toBeNull();
    expect(ruleNameOf('meta.kind')).toBe('meta.kind');
    expect(ruleNameOf('locals.svc')).toBe('svc');
    expect(ruleNameOf('rule.file')).toBeNull();
  });
});

describe('timeText / outputDisplay', () => {
  it('reads an epoch under a time key as local time, keeping the nanoseconds past the millisecond', () => {
    const ms = new Date(2026, 10, 24, 20, 42, 38, 33).getTime();
    expect(timeText('timestamp', ms)).toBe('2026-11-24 20:42:38.033');
    expect(timeText('startTimeUnixNano', `${ms}123456`)).toBe('2026-11-24 20:42:38.033123456');
    expect(timeText('segmentStartTime', String(ms))).toBe('2026-11-24 20:42:38.033');
  });

  it('leaves a minute bucket, a latency and a non-time key alone', () => {
    expect(timeText('timeBucket', 202611241003)).toBeNull();
    expect(timeText('latency', 1795524158033)).toBeNull();
    expect(timeText('spanId', '1795524158033')).toBeNull();
  });

  it('reads a metric’s observation as its value', () => {
    expect(outputDisplay({ kind: 'metrics', sourceLine: 90, metric: 'm', observation: 1, timestamp: 5 })).toEqual({
      metric: 'm',
      value: 1,
      timestamp: 5,
    });
  });
});

describe('the lines a run covers', () => {
  const file = [
    'filter {', //                                      1
    '  if (meta.kind == "SERVER"', //                   2
    '      && hasAttr("http.method")) {', //            3
    '    metrics { name "cpm"; scope svc;', //          4
    '              function cpm; value 1 }', //         5
    '    def x = foo(a,', //                            6
    '                b)', //                            7
    '  }', //                                           8
    '}', //                                             9
  ];
  const textOf = (n: number): string | undefined => file[n - 1];

  it('takes a wrapped condition through its `{`, a metrics body to its brace, and a wrapped def to its `)`', () => {
    expect(stepLines({ stage: 'filter', kind: 'if', sourceLine: 2, sourceText: file[1] }, 2, textOf)).toEqual([2, 3]);
    expect(stepLines({ stage: 'filter', kind: 'metrics', sourceLine: 4, output: 0 }, 4, textOf)).toEqual([4, 5]);
    expect(stepLines({ stage: 'filter', kind: 'def', sourceLine: 6, sourceText: file[5] }, 6, textOf)).toEqual([6, 7]);
    expect(stepLines({ stage: 'filter', kind: 'block', sourceLine: 1 }, 1, textOf)).toEqual([1]);
  });

  it('counts no bracket inside a single-quoted string', () => {
    const file = ["  if (meta.service == '(') {", '    abort {}', '  }'];
    const textOf = (line: number): string | undefined => file[line - 1];
    expect(stepLines({ stage: 'filter', kind: 'if', sourceLine: 1, sourceText: "if (meta.service == '(')" }, 1, textOf))
      .toEqual([1]);
  });

  it('claims no line for a failure: the statement that threw is past the last step', () => {
    const run = {
      continueOn: false,
      reason: 'boom',
      steps: [
        { stage: 'filter', kind: 'def', sourceLine: 6, value: 1 },
        { stage: 'filter', kind: 'failure', value: 'boom' },
      ],
      outputs: [],
    };
    expect([...lineValues(run, null).keys()]).toEqual([6]);
    expect(lineValues(run, null).get(6)?.marker, 'the def that ran is not the one that threw').toBeNull();
  });

  it('tells whether the file holds the DSL where the capture numbered it from', () => {
    const file = ['rules:', '  - name: a', '    dsl: |', '      filter {', '        abort {}', '      }'];
    expect(dslAt(file, 'filter {\n  abort {}\n}\n', 3)).toBe(true);
    expect(dslAt(file, 'filter {\n  abort {}\n}\n', 2), 'a line off: the rule moved').toBe(false);
    expect(dslAt(file, 'filter {\n  abort {} \n  log\n}\n', 3), 'the DSL changed').toBe(false);
  });

  it('finds the rule’s own DSL block at or after its line', () => {
    const lines = ['rules:', '  - name: a', '    dsl: |', '      x', '  - name: b', '    dsl: |', '      x'];
    expect(dslOffsetIn(lines, 'x\n', 0)).toBe(3);
    expect(dslOffsetIn(lines, 'x\n', 5)).toBe(6);
  });
});
