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
import { explainEmptyCatalog } from './unreadable.js';

describe('explainEmptyCatalog', () => {
  it('distinguishes an unreachable store from an empty layer', () => {
    const outage = explainEmptyCatalog('store-unreachable', 'GENERAL', 'service');
    const empty = explainEmptyCatalog('ok', 'GENERAL', 'service');
    expect(outage).not.toBe(empty);
    // The whole point: the outage message must not read as "nothing here".
    expect(outage).toMatch(/EVERY layer/);
    expect(outage).toMatch(/unreachable/);
    // It must not overstate: the query port is unaffected.
    expect(outage).toMatch(/QUERY port and still work/);
    expect(empty).toMatch(/read successfully/);
  });

  it('tells the agent to stop rather than try other layers on an outage', () => {
    const msg = explainEmptyCatalog('store-unreachable', 'MESH');
    expect(msg).toMatch(/do not retry other layers/i);
    expect(msg).toMatch(/check_horizon_health/);
  });

  it('names the blast radius per reason', () => {
    expect(explainEmptyCatalog('store-unreachable', 'GENERAL')).toMatch(/EVERY layer/);
    expect(explainEmptyCatalog('layer-disabled', 'GENERAL')).toMatch(/other layers are unaffected/i);
    expect(explainEmptyCatalog('no-remote-row', 'GENERAL')).toMatch(/other layers are unaffected/i);
  });

  it('names an administrator action as deliberate, not as breakage', () => {
    const msg = explainEmptyCatalog('layer-disabled', 'K8S_SERVICE', 'instance');
    expect(msg).toMatch(/administrator disabled/i);
    expect(msg).toMatch(/K8S_SERVICE/);
    expect(msg).toMatch(/instance/);
  });

  it('does not tell the operator to sync a template when the read simply failed', () => {
    const msg = explainEmptyCatalog('read-error', 'GENERAL');
    // It may mention "unsynced" to rule it out; what it must not do is assert it.
    expect(msg).not.toMatch(/no template is synced/i);
    expect(msg).not.toBe(explainEmptyCatalog('no-remote-row', 'GENERAL'));
    expect(msg).toMatch(/check_horizon_health/);
  });

  it('scopes the sentence when a scope is given and not otherwise', () => {
    expect(explainEmptyCatalog('ok', 'GENERAL', 'endpoint')).toMatch(/at scope "endpoint"/);
    expect(explainEmptyCatalog('ok', 'GENERAL')).not.toMatch(/at scope/);
  });
});
