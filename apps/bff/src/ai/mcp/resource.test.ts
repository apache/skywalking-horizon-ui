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

import { describe, it, expect } from 'vitest';
import { withRenderers } from './resource.js';

const CARD = 'ui://horizon/app/abc123def456';
const KEY = 'org.apache.skywalking.horizon/payload';
const reply = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: 'captured' }],
  structuredContent: { [KEY]: payload },
});

describe('only a reply that carries a CARD points at the card renderer', () => {
  /**
   * Every tool returns structured content, so "has structuredContent" is true
   * for a plain list too. Pointing those at the bundle made a host mount a
   * frame for `list_services`, which then reported it had been handed nothing
   * to draw — an empty widget on every rows reply, once per tool call.
   */
  it('says nothing for a rows reply, which has no kind', () => {
    const rows = reply({ tool: 'list_services', data: { services: [] } });
    expect(withRenderers(rows, CARD)).toBe(rows);
  });

  it('points a card reply at the bundle', () => {
    const card = reply({ tool: 'show_traces', kind: 'traces', spec: {} });
    const out = withRenderers(card, CARD);
    expect(out._meta?.ui).toEqual({ resourceUri: CARD });
    expect(out.content.map((c) => c.text).join('\n')).toContain(CARD);
  });

  it('says nothing when there is no bundle to mount', () => {
    const card = reply({ tool: 'show_traces', kind: 'traces', spec: {} });
    expect(withRenderers(card, undefined)).toBe(card);
  });

  it('says nothing on a reply with no structured content at all', () => {
    const prose = { content: [{ type: 'text' as const, text: 'Permission denied.' }] };
    expect(withRenderers(prose, CARD)).toBe(prose);
  });
});
