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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mountConversationView, type AszViewDocument, type ConversationView } from '../src/index.js';
import { ConversationModel } from '../src/model.js';

/** The Sessionizer's mcp-calls scenario, as the OAP's fixture holds it: three
 *  calls to one MCP server on the main stream, one failed, a call in a
 *  subagent to another server, each with its execution record, and a call
 *  whose name splits two ways and so names no server. */
const fixture = JSON.parse(readFileSync(resolve('test/fixtures/mcp-calls.json'), 'utf8')) as AszViewDocument;
/** The original example, from before execution records existed. */
const plain = JSON.parse(readFileSync(resolve('test/fixtures/asz-view-example.json'), 'utf8')) as AszViewDocument;

const LOOKUP = 'tool/s2-tool';
const FAILED = 'tool/s3-tool';
const ODD = 'tool/s5-tool';

let view: ConversationView | null = null;
let host: HTMLElement | null = null;

function mount(doc: AszViewDocument = fixture): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  view = mountConversationView(host, { document: doc });
  return host;
}

function openFold(root: HTMLElement): void {
  root.querySelector<HTMLButtonElement>('.acv-fold[data-work]')!.click();
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

describe('the model over calls to MCP servers', () => {
  it('puts a call that names its server on the MCP lane, and one whose name does not split on the tools lane', () => {
    const m = new ConversationModel(fixture);
    expect(m.step(LOOKUP)!.mcp).toEqual({ server: 'status', tool: 'lookup' });
    expect(m.step(LOOKUP)!.track).toBe('mcp');
    expect(m.step('tool/auditor-s1-tool')!.mcp).toEqual({ server: 'docs', tool: 'read' });
    expect(m.step(ODD)!.mcp).toBeUndefined();
    expect(m.step(ODD)!.track).toBe('tools');
  });

  it('joins execution records to steps by `step`, and keeps the ones no step carries apart', () => {
    const m = new ConversationModel(fixture);
    expect(m.toolExecutions).toHaveLength(4);
    expect(m.executionsOf(LOOKUP).map((x) => x.outcome)).toEqual(['returned']);
    expect(m.executionsOf(FAILED)[0]!.duration_ms).toBe(2000);
    expect(m.executionsOf(ODD)).toHaveLength(0);
    const copy = JSON.parse(JSON.stringify(fixture)) as AszViewDocument;
    copy.tool_executions = [{ ...copy.tool_executions![0]!, step: '' }];
    const unjoined = new ConversationModel(copy);
    expect(unjoined.toolExecutions).toHaveLength(1);
    expect(unjoined.executionsOf(LOOKUP)).toHaveLength(0);
  });
});

describe('an MCP call on the page', () => {
  it('names its server in the role and its server and tool in the title, and wears how it ended', () => {
    const root = mount();
    openFold(root);
    const card = root.querySelector<HTMLElement>(`[data-card="${LOOKUP}"]`)!;
    expect(card.querySelector('.acv-role')!.textContent).toContain('→ MCP · status');
    expect(card.querySelector('.acv-title')!.textContent).toContain('status · lookup');
    expect(card.querySelector('.acv-execution-pill')!.textContent).toBe('returned · 380 ms');
    const failed = root.querySelector<HTMLElement>(`[data-card="${FAILED}"] .acv-execution-pill`)!;
    expect(failed.classList.contains('failed')).toBe(true);
    expect(failed.textContent).toBe('failed · 2.0 s');
    // no server, no pill: the call whose name does not split stays a plain tool
    const odd = root.querySelector<HTMLElement>(`[data-card="${ODD}"]`)!;
    expect(odd.querySelector('.acv-execution-pill')).toBeNull();
    expect(odd.querySelector('.acv-role')!.textContent).toContain('Tool');
  });

  it('opens the Execution tab from its pill, with the server, the outcome, the measured time and the sizes', () => {
    const root = mount();
    openFold(root);
    root.querySelector<HTMLButtonElement>(`[data-card="${LOOKUP}"] .acv-execution-pill`)!.click();
    const tab = root.querySelector<HTMLButtonElement>('[data-tab="execution"]')!;
    expect(tab.hidden).toBe(false);
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const body = root.querySelector('.acv-inspector-body')!.textContent!;
    expect(body).toContain('asz-plugin · client_hook');
    expect(body).toContain('status');
    expect(body).toContain('user');
    expect(body).toContain('returned');
    expect(body).toContain('380 ms');
    expect(body).toContain('22 B · SHA-256 ea3a64398a82');
    expect(body).toContain('seq 2 · row 1 · block 0');
    expect(body).toContain("not the server's own time");
  });

  it('writes every value of a record as text, the reference numbers included', () => {
    const copy = JSON.parse(JSON.stringify(fixture)) as AszViewDocument;
    const record = copy.tool_executions!.find((x) => x.step === LOOKUP)!;
    record.ref = { ...record.ref, seq: '<img src=x>' as unknown as number };
    record.server = { name: '<b>status</b>', source: 'user' };
    const root = mount(copy);
    openFold(root);
    root.querySelector<HTMLButtonElement>(`[data-card="${LOOKUP}"] .acv-execution-pill`)!.click();
    const body = root.querySelector('.acv-inspector-body')!;
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('b')).toBeNull();
    expect(body.textContent).toContain('seq <img src=x>');
    expect(body.textContent).toContain('<b>status</b>');
  });

  it('labels the record it opens in Evidence as an execution record', () => {
    const root = mount();
    openFold(root);
    root.querySelector<HTMLButtonElement>(`[data-card="${LOOKUP}"] .acv-execution-pill`)!.click();
    root.querySelector<HTMLButtonElement>('.acv-inspector-body [data-to-evidence]')!.click();
    const body = root.querySelector('.acv-inspector-body')!.textContent!;
    expect(body).toContain('execution record');
    expect(body).not.toContain('change record');
  });

  it('says in Details which server and tool the call addressed, and links to its records', () => {
    const root = mount();
    openFold(root);
    root.querySelector<HTMLElement>(`[data-card="${LOOKUP}"]`)!.click();
    const body = root.querySelector('.acv-inspector-body')!;
    expect(body.textContent).toContain('MCP server');
    expect(body.textContent).toContain('MCP tool');
    body.querySelector<HTMLButtonElement>('[data-to-execution]')!.click();
    expect(root.querySelector('[data-tab="execution"]')!.getAttribute('aria-selected')).toBe('true');
  });

  it('draws calls to MCP servers on their own lane, named by server and tool', () => {
    const root = mount();
    openFold(root);
    const lanes = [...root.querySelectorAll('.acv-lane-label')].map((l) => l.textContent);
    expect(lanes).toContain('MCP');
    expect(lanes).toContain('Tools');
    const clip = root.querySelector<HTMLElement>(`.acv-clip[data-node="${LOOKUP}"]`)!;
    expect(clip.textContent).toBe('status · lookup');
    expect(clip.title).toContain('returned');
    const odd = root.querySelector<HTMLElement>(`.acv-clip[data-node="${ODD}"]`)!;
    expect(odd.textContent).toBe('mcp__odd__name__twice');
    expect(Number.parseFloat(odd.style.top)).not.toBe(Number.parseFloat(clip.style.top));
  });

  it('shows no Execution tab and no lane for a document from before execution records', () => {
    const root = mount(plain);
    openFold(root);
    expect(root.querySelector('.acv-execution-pill')).toBeNull();
    expect([...root.querySelectorAll('.acv-lane-label')].map((l) => l.textContent)).not.toContain('MCP');
    root.querySelector<HTMLElement>('[data-card]')!.click();
    expect(root.querySelector<HTMLButtonElement>('[data-tab="execution"]')!.hidden).toBe(true);
  });
});
