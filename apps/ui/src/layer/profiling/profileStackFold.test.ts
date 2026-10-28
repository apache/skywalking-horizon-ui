// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements.  See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { describe, it, expect } from 'vitest';
import type { ProfileAnalyzationElement, ProfileAnalyzationTree } from '@/api/client';
import {
  FRAME_PRESETS,
  foldStack,
  isFrameHidden,
  normalizeHidePattern,
  stackStats,
  type StackNode,
} from './profileStackFold';

/** A single-child chain, shaped like a Tomcat request that sleeps in app code:
 *  every frame carries the whole duration and only the JDK leaf has self time. */
function chain(signatures: string[], duration = 5000): ProfileAnalyzationTree {
  const elements: ProfileAnalyzationElement[] = signatures.map((codeSignature, i) => ({
    id: String(i + 1),
    parentId: String(i),
    codeSignature,
    duration,
    durationChildExcluded: i === signatures.length - 1 ? duration : 0,
    count: 99,
  }));
  return { elements };
}

const REQUEST = chain([
  'java.lang.Thread.run:750',
  'org.apache.tomcat.util.threads.TaskThread$WrappingRunnable.run:61',
  'org.apache.catalina.core.StandardHostValve.invoke:135',
  'com.example.OrderController.create:42',
  'com.example.OrderService.place:88',
  'java.util.concurrent.TimeUnit.sleep:386',
  'java.lang.Thread.sleep:-2',
]);

/** The last row of a single-child chain. */
function deepest(nodes: StackNode[]): StackNode {
  let n = nodes[0];
  while (n.children.length) n = n.children[0];
  return n;
}

/** Rows top to bottom, a folded group shown as `⋯N`. */
function rows(nodes: StackNode[]): string[] {
  return nodes.flatMap((n) => [n.codeSignature ?? `⋯${n.hidden.length}`, ...rows(n.children)]);
}

describe('foldStack', () => {
  it('without patterns keeps every frame, in order', () => {
    expect(rows(foldStack([REQUEST]))).toHaveLength(7);
    expect(rows(foldStack([REQUEST]))[0]).toBe('java.lang.Thread.run:750');
  });

  it('folds each unbroken run of hidden frames into one row', () => {
    const out = foldStack([REQUEST], { hidePatterns: ['java.', 'org.apache.'] });
    expect(rows(out)).toEqual([
      '⋯3',
      'com.example.OrderController.create:42',
      'com.example.OrderService.place:88',
      '⋯2',
    ]);
  });

  it('keeps the self time of the frames it hides', () => {
    const out = foldStack([REQUEST], { hidePatterns: ['java.'] });
    const leafGroup = deepest(out);
    expect(leafGroup.hidden.map((e) => e.codeSignature)).toEqual([
      'java.util.concurrent.TimeUnit.sleep:386',
      'java.lang.Thread.sleep:-2',
    ]);
    expect(leafGroup.durationChildExcluded).toBe(5000);
    expect(leafGroup.duration).toBe(5000);
    expect(leafGroup.count).toBe(99);
  });

  it('marks a group as one of the slowest when a frame in it is', () => {
    const out = foldStack([REQUEST], { hidePatterns: ['java.'] });
    const leafGroup = deepest(out);
    expect(leafGroup.top).toBe(true);
    expect(out[0].children[0].top).toBe(false);
  });

  it('shows an unfolded group as frames, with a way back on its top frame', () => {
    const folded = foldStack([REQUEST], { hidePatterns: ['java.', 'org.apache.'] });
    const key = folded[0].key;
    const out = foldStack([REQUEST], { hidePatterns: ['java.', 'org.apache.'], unfolded: new Set([key]) });
    expect(rows(out).slice(0, 4)).toEqual([
      'java.lang.Thread.run:750',
      'org.apache.tomcat.util.threads.TaskThread$WrappingRunnable.run:61',
      'org.apache.catalina.core.StandardHostValve.invoke:135',
      'com.example.OrderController.create:42',
    ]);
    expect(out[0].unfoldedGroupKey).toBe(key);
    expect(out[0].children[0].unfoldedGroupKey).toBeNull();
    // Unfolding one group leaves the others folded.
    expect(rows(out)[5]).toBe('⋯2');
  });

  it('hangs the visible children of every hidden frame under the group', () => {
    const tree: ProfileAnalyzationTree = {
      elements: [
        { id: '1', parentId: '0', codeSignature: 'java.lang.Thread.run', duration: 10, durationChildExcluded: 0, count: 2 },
        { id: '2', parentId: '1', codeSignature: 'java.util.Executor.run', duration: 10, durationChildExcluded: 1, count: 2 },
        { id: '3', parentId: '2', codeSignature: 'com.example.A.a', duration: 4, durationChildExcluded: 4, count: 1 },
        { id: '4', parentId: '2', codeSignature: 'com.example.B.b', duration: 5, durationChildExcluded: 5, count: 1 },
      ],
    };
    const out = foldStack([tree], { hidePatterns: ['java.'] });
    expect(out).toHaveLength(1);
    expect(out[0].hidden).toHaveLength(2);
    expect(out[0].durationChildExcluded).toBe(1);
    expect(out[0].children.map((c) => c.codeSignature)).toEqual(['com.example.A.a', 'com.example.B.b']);
  });

  it('keys stay unique across trees', () => {
    const out = foldStack([REQUEST, REQUEST], { hidePatterns: ['java.'] });
    expect(out[0].key).not.toBe(out[1].key);
  });

  it('matches the search text in frames and inside groups, ignoring case', () => {
    const out = foldStack([REQUEST], { hidePatterns: ['java.'], search: 'SLEEP' });
    expect(stackStats(out)).toEqual({ hidden: 3, matches: 1 });
    expect(stackStats(foldStack([REQUEST], { search: 'orderservice' })).matches).toBe(1);
  });

  // OAP's Go analyzer roots its tree at parent -1 with the root's own id 0, so
  // the root's children carry parent "0" — which is NOT the root marker here.
  it('roots a Go tree at its parent -1 frame', () => {
    const go: ProfileAnalyzationTree = {
      elements: [
        { id: '0', parentId: '-1', codeSignature: 'runtime.goexit:1695', duration: 30, durationChildExcluded: 0, count: 3 },
        { id: '1', parentId: '0', codeSignature: 'net/http.(*conn).serve:2009', duration: 20, durationChildExcluded: 0, count: 2 },
        { id: '2', parentId: '0', codeSignature: 'main.worker:12', duration: 10, durationChildExcluded: 10, count: 1 },
        { id: '3', parentId: '1', codeSignature: 'main.handler:30', duration: 20, durationChildExcluded: 20, count: 2 },
      ],
    };
    const out = foldStack([go]);
    expect(out.map((n) => n.codeSignature)).toEqual(['runtime.goexit:1695']);
    expect(rows(out)).toEqual(['runtime.goexit:1695', 'net/http.(*conn).serve:2009', 'main.handler:30', 'main.worker:12']);
    expect(rows(foldStack([go], { hidePatterns: [...FRAME_PRESETS.goStd] }))).toEqual(['⋯2', 'main.handler:30', 'main.worker:12']);
  });
});

describe('hide patterns', () => {
  const hides = (signature: string, patterns: readonly string[]) => isFrameHidden(signature, patterns);

  it('match from the start of the name, a * standing for any text', () => {
    expect(hides('org.apache.tomcat.util.net.SocketProcessorBase.run:49', ['org.apache.tomcat.'])).toBe(true);
    expect(hides('com.example.org.apache.tomcat.Fake.run:1', ['org.apache.tomcat.'])).toBe(false);
    expect(hides('/app/.venv/lib/python3.11/site-packages/flask/app.py.wsgi_app: 2190', ['*/site-packages/'])).toBe(true);
    expect(hides('/app/main.py.index: 12', ['*/site-packages/'])).toBe(false);
  });

  it('treat everything but * literally', () => {
    expect(hides('net/http.(*conn).serve:2009', ['net/http.(*conn)'])).toBe(true);
    expect(hides('a.b$c:1', ['a.b$'])).toBe(true);
    expect(hides('aXb:1', ['a.b'])).toBe(false);
  });

  it('the Go standard-library preset leaves Java packages that start the same way alone', () => {
    expect(hides('io.(*pipe).read:57', FRAME_PRESETS.goStd)).toBe(true);
    expect(hides('net.(*conn).Read:179', FRAME_PRESETS.goStd)).toBe(true);
    expect(hides('io.netty.channel.nio.NioEventLoop.run:569', FRAME_PRESETS.goStd)).toBe(false);
    expect(hides('net.bytebuddy.agent.builder.AgentBuilder.transform:1', FRAME_PRESETS.goStd)).toBe(false);
  });

  it('the Python preset hides the standard library and installed packages, not the application', () => {
    expect(hides('/usr/lib/python3.11/threading.py.run: 975', FRAME_PRESETS.pythonLibraries)).toBe(true);
    expect(hides('/app/.venv/lib/python3.11/site-packages/flask/app.py.wsgi_app: 2190', FRAME_PRESETS.pythonLibraries)).toBe(true);
    expect(hides('/app/views.py.index: 12', FRAME_PRESETS.pythonLibraries)).toBe(false);
  });

  // The agent renames an enhanced method's body to `$sw$original$…`, and that
  // frame carries the operator's own line number.
  it('the SkyWalking Java agent preset keeps the original method body', () => {
    const sw = FRAME_PRESETS.skywalkingJava;
    expect(hides('org.apache.skywalking.apm.agent.core.plugin.interceptor.enhance.InstMethodsInter.intercept:95', sw)).toBe(true);
    expect(hides('test.apache.skywalking.e2e.profile.ProfileController$$sw$auxiliary$q8srr03.call:-1', sw)).toBe(true);
    expect(hides('test.apache.skywalking.e2e.profile.ProfileController.$sw$original$createAuthor$sih1te1$accessor$$sw$o9eom32:-1', sw)).toBe(true);
    expect(hides('test.apache.skywalking.e2e.profile.ProfileController.$sw$original$createAuthor$sih1te1:38', sw)).toBe(false);
  });
});

describe('normalizeHidePattern', () => {
  it('reads a trailing wildcard as the plain prefix', () => {
    expect(normalizeHidePattern('java.*')).toBe('java.');
    expect(normalizeHidePattern(' org.apache.tomcat. ')).toBe('org.apache.tomcat.');
    expect(normalizeHidePattern('*/site-packages/*')).toBe('*/site-packages/');
  });

  it('refuses an empty value', () => {
    expect(normalizeHidePattern('*')).toBeNull();
    expect(normalizeHidePattern('**')).toBeNull();
    expect(normalizeHidePattern('  ')).toBeNull();
  });
});
