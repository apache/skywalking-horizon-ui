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
 * The 401 hook ends the session, which empties the debug event log — so the
 * breadcrumb naming the request that bounced the operator has to be written
 * on the far side of the hook, or the one line that explains why the ticker
 * went blank is the single line the wipe takes with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BffClient } from './client';
import { pushEvent, resetEventLog, useEventLog } from '@/controls/eventLog';

describe('BffClient — the 401 breadcrumb survives the session reset it triggers', () => {
  beforeEach(() => {
    resetEventLog();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 401, ok: false })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs the bounced request AFTER the hook wiped the log', async () => {
    const client = new BffClient();
    client.setOn401(() => resetEventLog());
    pushEvent('route', 'info', 'Navigated to /layer/GENERAL/trace');

    await expect(client.request('GET', '/api/layer/GENERAL/traces')).rejects.toMatchObject({
      status: 401,
    });

    const texts = useEventLog().all.value.map((e) => e.text);
    expect(texts).toContain('GET /api/layer/GENERAL/traces · 401 (re-auth)');
    // Everything the previous session logged is still gone — only the
    // explanation survives.
    expect(texts).toHaveLength(1);
  });

  it('the multipart path logs it on the same side of the hook', async () => {
    const client = new BffClient();
    client.setOn401(() => resetEventLog());

    await expect(
      client.requestForm('POST', '/api/sourcemaps', new FormData()),
    ).rejects.toMatchObject({ status: 401 });

    expect(useEventLog().all.value.map((e) => e.text)).toContain(
      'POST /api/sourcemaps · 401 (re-auth)',
    );
  });
});
