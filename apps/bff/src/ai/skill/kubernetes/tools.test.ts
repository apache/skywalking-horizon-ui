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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// OAP + server-offset are mocked so the tools are testable without a live OAP.
vi.mock('../../../client/graphql.js', () => ({ graphqlPost: vi.fn() }));
vi.mock('../../../util/window.js', () => ({
  getServerOffsetMinutes: vi.fn().mockResolvedValue(0),
  fmtSecond: (ms: number) => new Date(ms).toISOString(),
}));

import { kubernetesTools, isFeatureUnavailable } from './tools.js';
import { graphqlPost } from '../../../client/graphql.js';
import type { AiRequestContext } from '../../context.js';

const gql = graphqlPost as unknown as ReturnType<typeof vi.fn>;

function mockCtx(hasVerb = true) {
  const emitPodLogs = vi.fn();
  const ctx = {
    hasVerb: () => hasVerb,
    emitPodLogs,
    opts: {},
    config: {},
    fetch: undefined,
  } as unknown as AiRequestContext;
  return { ctx, emitPodLogs };
}
function tools(ctx: AiRequestContext) {
  const [list, fetchLogs] = kubernetesTools(ctx);
  return { list, fetchLogs };
}

beforeEach(() => gql.mockReset());

describe('kubernetes pod-log tools', () => {
  it('denies both tools without logs:read, and never touches OAP', async () => {
    const { ctx } = mockCtx(false);
    const { list, fetchLogs } = tools(ctx);
    expect(String(await list.invoke({ serviceInstanceId: 'p' }))).toMatch(/permission|logs:read/i);
    expect(
      String(await fetchLogs.invoke({ layer: 'K8S_SERVICE', serviceInstanceId: 'p', container: 'c' })),
    ).toMatch(/permission|logs:read/i);
    expect(gql).not.toHaveBeenCalled();
  });

  it('list_pod_containers returns the container names', async () => {
    gql.mockResolvedValue({ containers: { errorReason: null, containers: ['app', 'sidecar'] } });
    const { list } = tools(mockCtx().ctx);
    const out = String(await list.invoke({ serviceInstanceId: 'pod-1' }));
    expect(out).toContain('app');
    expect(out).toContain('sidecar');
  });

  it('detects the OAP feature-off (schema field absent) error, and only that', () => {
    // OAP hides the field when enableOnDemandPodLog=false → a validation error.
    expect(
      isFeatureUnavailable(
        "Validation error of type FieldUndefined: Field 'listContainers' in type 'Query' is undefined",
      ),
    ).toBe(true);
    expect(isFeatureUnavailable("Cannot query field 'ondemandPodLogs' on type 'Query'")).toBe(true);
    // A real runtime error (OAP up, feature on) must NOT be misread as "disabled".
    expect(isFeatureUnavailable('ECONNREFUSED 127.0.0.1:12800')).toBe(false);
    expect(isFeatureUnavailable("Cannot query field 'somethingElse' on type 'Query'")).toBe(false);
  });

  it('fetch_pod_logs mounts a live pane, ships the sibling container list, and returns the lines', async () => {
    // Even with an explicit container, the tool still resolves the pod's full
    // container list so the pane can offer a switcher (fix for the single-element list).
    gql.mockImplementation((_opts: unknown, query: unknown) => {
      if (String(query).includes('listContainers')) {
        return Promise.resolve({ containers: { errorReason: null, containers: ['app', 'istio-proxy'] } });
      }
      return Promise.resolve({
        logs: {
          errorReason: null,
          logs: [
            { content: 'starting up', timestamp: 1 },
            { content: 'ERROR boom', timestamp: 2 },
          ],
        },
      });
    });
    const { ctx, emitPodLogs } = mockCtx();
    const { fetchLogs } = tools(ctx);
    const out = String(
      await fetchLogs.invoke({
        layer: 'k8s_service',
        serviceInstanceId: 'pod-1',
        container: 'app',
        service: 'agent::songs',
        pod: 'songs-1',
      }),
    );
    expect(emitPodLogs).toHaveBeenCalledTimes(1);
    expect(emitPodLogs.mock.calls[0][0]).toMatchObject({
      service: 'agent::songs',
      pod: 'songs-1',
      container: 'app',
    });
    expect(emitPodLogs.mock.calls[0][0].initialLines).toHaveLength(2);
    expect(out).toContain('ERROR boom');
  });

  it('fetch_pod_logs surfaces an OAP errorReason without treating it as data', async () => {
    // OAP returns errorReason (not a thrown error) when the pod is stale.
    gql.mockResolvedValue({ logs: { errorReason: 'No pod can be found', logs: [] } });
    const { ctx, emitPodLogs } = mockCtx();
    const { fetchLogs } = tools(ctx);
    const out = String(
      await fetchLogs.invoke({ layer: 'K8S_SERVICE', serviceInstanceId: 'p', container: 'app' }),
    );
    expect(out).toMatch(/No pod can be found/);
    // A pane is still mounted (so the operator can re-pick a live pod), carrying the reason.
    expect(emitPodLogs).toHaveBeenCalledTimes(1);
    expect(emitPodLogs.mock.calls[0][0]).toMatchObject({ errorReason: 'No pod can be found' });
  });
});
