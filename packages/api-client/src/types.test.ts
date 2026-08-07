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
import {
  CATALOGS,
  RuntimeRuleApiError,
  isCatalog,
  isTerminalPhase,
  parseApiErrorBody,
} from './types.js';
import { DEBUG_CATALOGS } from './dsl-debugging.js';

describe('isCatalog — the hot-update catalog gate', () => {
  it('pins the five hot-updatable catalog wire names, and accepts each of them', () => {
    // Membership has to be asserted directly: isCatalog derives from CATALOGS,
    // so the loop alone still passes with an entry silently dropped — and a
    // dropped catalog both disappears from the DSL dump picker and 400s
    // `invalid_catalog` on every hot-update aimed at it.
    expect([...CATALOGS].sort()).toEqual([
      'lal',
      'log-mal-rules',
      'meter-analyzer-config',
      'otel-rules',
      'telegraf-rules',
    ]);
    for (const c of CATALOGS) expect(isCatalog(c)).toBe(true);
  });

  it('rejects OAL — it is debuggable but permanently excluded from hot-update', () => {
    expect(isCatalog('oal')).toBe(false);
    expect(CATALOGS).not.toContain('oal');
    expect(DEBUG_CATALOGS).toContain('oal');
  });

  it('rejects non-strings and unknown names instead of throwing', () => {
    expect(isCatalog(undefined)).toBe(false);
    expect(isCatalog(null)).toBe(false);
    expect(isCatalog(42)).toBe(false);
    expect(isCatalog('OTEL-RULES')).toBe(false);
    expect(isCatalog('')).toBe(false);
  });
});

describe('isTerminalPhase — when an apply poller is allowed to stop', () => {
  it('stops on APPLIED, DEGRADED and FAILED', () => {
    // DEGRADED is forward-progress (committed + durable, fence unconfirmed);
    // polling past it would never terminate.
    expect(isTerminalPhase('APPLIED')).toBe(true);
    expect(isTerminalPhase('DEGRADED')).toBe(true);
    expect(isTerminalPhase('FAILED')).toBe(true);
  });

  it('keeps polling through every in-flight phase, and through UNKNOWN', () => {
    // UNKNOWN means "not tracked here" — the caller re-queries by contentHash
    // rather than declaring the apply finished.
    for (const p of ['PENDING', 'DDL', 'FENCING', 'ROLLING_OUT', 'UNKNOWN']) {
      expect(isTerminalPhase(p)).toBe(false);
    }
  });

  it('does not treat an unrecognised or lower-cased phase as terminal', () => {
    expect(isTerminalPhase('applied')).toBe(false);
    expect(isTerminalPhase('SOMETHING_NEW')).toBe(false);
    expect(isTerminalPhase('')).toBe(false);
  });
});

describe('RuntimeRuleApiError', () => {
  it('keeps status, url and the parsed body addressable for the route mapper', () => {
    const body = {
      applyStatus: 'requires_inactivate_first',
      catalog: 'lal',
      name: 'k8s',
      message: 'inactivate before delete',
    };
    const err = new RuntimeRuleApiError(409, body, 'http://oap:17128/runtime/rule/delete');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RuntimeRuleApiError');
    expect(err.status).toBe(409);
    expect(err.body).toBe(body);
    expect(err.message).toContain('409');
    expect(err.message).toContain('requires_inactivate_first');
    expect(err.message).toContain('inactivate before delete');
  });

  it('renders the code-keyed envelope from its own discriminator, not applyStatus', () => {
    // dsl-debugging / runtime-oal answer `{status,code,message}` — reading
    // `applyStatus` off that envelope printed a literal `undefined:` and
    // dropped the code. Verbatim 503 body of `POST /dsl-debugging/session`
    // when `injectionEnabled` is off.
    const err = new RuntimeRuleApiError(
      503,
      {
        status: 'error',
        code: 'injection_disabled',
        message: 'DSL debug capture is permanently disabled by configuration.',
      },
      'http://oap:17128/dsl-debugging/session?catalog=lal',
    );
    expect(err.message).toBe(
      '503 on http://oap:17128/dsl-debugging/session?catalog=lal — ' +
        'injection_disabled: DSL debug capture is permanently disabled by configuration.',
    );
    expect(err.message).not.toContain('undefined');
  });

  it('renders a routing failure through applyStatus, extra fields and all', () => {
    // `cluster_view_split` is a runtime-rule routing refusal (HTTP 421,
    // `applyStatus`-keyed, with an extra `mainNode` naming the peer it
    // wouldn't re-forward to) — NOT one of the code-keyed dsl-debugging
    // failures. It stays on the applyStatus branch, and the extra field
    // neither confuses the discriminator nor gets dropped.
    const body = parseApiErrorBody(
      JSON.stringify({
        applyStatus: 'cluster_view_split',
        catalog: 'lal',
        name: 'k8s',
        mainNode: '10.0.0.7:17128',
        message:
          'forwarded request but self is not main under local cluster view; ' +
          'routing misfire or split-brain',
      }),
    );
    expect(body).toMatchObject({
      applyStatus: 'cluster_view_split',
      mainNode: '10.0.0.7:17128',
    });
    const err = new RuntimeRuleApiError(421, body, 'http://oap:17128/runtime/rule/addOrUpdate');
    expect(err.message).toContain('cluster_view_split: forwarded request but self is not main');
    expect(err.message).not.toContain('undefined');
  });

  it('summarises a raw-text body without pretending it was structured', () => {
    const err = new RuntimeRuleApiError(502, 'upstream connect error', 'http://oap:17128/x');
    expect(err.body).toBe('upstream connect error');
    expect(err.message).toContain('upstream connect error');
  });
});

describe('parseApiErrorBody — which failure envelope OAP sent', () => {
  it('keeps the applyStatus envelope of the runtime-rule pipeline', () => {
    const body = {
      applyStatus: 'requires_inactivate_first',
      catalog: 'lal',
      name: 'k8s',
      message: 'inactivate before delete',
    };
    expect(parseApiErrorBody(JSON.stringify(body))).toEqual(body);
  });

  it('keeps the code envelope of the dsl-debugging / oal handlers', () => {
    // Object (not string) is what lets the BFF audit `code` and the UI
    // switch on it; degrading it to text costs both. Verbatim 400 body of
    // `GET /runtime/oal/rules/{source}`.
    const body = {
      status: 'error',
      code: 'missing_source',
      message: 'source path param is required',
    };
    expect(parseApiErrorBody(JSON.stringify(body))).toEqual(body);
  });

  it('falls back to the verbatim text for anything else', () => {
    expect(parseApiErrorBody('<html>502 Bad Gateway</html>')).toBe('<html>502 Bad Gateway</html>');
    // JSON, but neither envelope — no faking one up.
    expect(parseApiErrorBody('{"error":"nope"}')).toBe('{"error":"nope"}');
    // `status: 'error'` alone is not the envelope; the code is what callers read.
    expect(parseApiErrorBody('{"status":"error","message":"boom"}')).toBe(
      '{"status":"error","message":"boom"}',
    );
    expect(parseApiErrorBody('null')).toBe('null');
    expect(parseApiErrorBody('')).toBe('');
  });
});
