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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BffApiError, bffClient, describeApiError } from './client';
import { errorText, isPermissionDenied, permissionDeniedText } from './permissionDenied';

const refused = (body: unknown) => new BffApiError(403, 'POST /api/layer/general/logs failed (403)', body);

afterEach(() => vi.unstubAllGlobals());

describe('a refused data read', () => {
  it('reads as a sentence when the BFF says why', () => {
    const err = refused({ error: 'permission_denied', verb: 'logs:read', reason: 'service_required' });
    expect(permissionDeniedText(err)).toMatch(/^Pick a service/);
    expect(describeApiError(err)).toMatch(/^Pick a service/);
    expect(errorText(err)).toMatch(/^Pick a service/);
    expect(permissionDeniedText(refused({ error: 'permission_denied', verb: 'metrics:read', reason: 'layer_not_granted', layer: 'banyandb' })))
      .toBe('You do not have access to the BANYANDB layer.');
  });

  it('keeps today\'s wording for a refusal without a reason, and for any other failure', () => {
    const plain = refused({ error: 'permission_denied', verb: 'metrics:read' });
    expect(isPermissionDenied(plain)).toBe(true);
    expect(permissionDeniedText(plain)).toBeNull();
    expect(describeApiError(plain)).toBe('403: permission_denied');
    const failed = new BffApiError(500, 'GET /api/x failed (500)', { error: 'boom' });
    expect(isPermissionDenied(failed)).toBe(false);
    expect(errorText(failed)).toBe(String(failed));
  });

  it('becomes the thrown error\'s message, so pages printing err.message say why', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'permission_denied', verb: 'traces:read', reason: 'service_not_granted' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )));
    await expect(bffClient.request('POST', '/api/layer/general/traces', {})).rejects.toThrow('You do not have access to this service.');
  });
});
