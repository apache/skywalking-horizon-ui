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
 * The dump download is the one call in this scope that never goes through
 * `fetch` — it hands a URL to the browser via an anchor. A root-relative
 * href works at `/` and silently 404s under a gateway sub-path, so the
 * base prefix has to be asserted on the anchor itself, not on the helper.
 *
 * `withBase` snapshots `import.meta.env.BASE_URL` at module-eval time, so
 * the base is stubbed BEFORE the dynamic import of a freshly reset module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Capture the anchors `triggerDump` creates without letting jsdom
 *  navigate on the synthetic click. */
function captureAnchors(): HTMLAnchorElement[] {
  const anchors: HTMLAnchorElement[] = [];
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = create(tag);
    if (tag === 'a') {
      (el as HTMLAnchorElement).click = () => {};
      anchors.push(el as HTMLAnchorElement);
    }
    return el;
  }) as typeof document.createElement);
  return anchors;
}

async function loadDslApi() {
  // Through the façade, not `new DslApi(...)`: client ↔ scope is a cycle,
  // and entering it from the scope side leaves the client's members in TDZ.
  const { bffClient } = await import('../client');
  return bffClient.dsl;
}

describe('DSL dump download resolves against the deploy base', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('prefixes the sub-path base onto the all-catalogs dump', async () => {
    vi.stubEnv('BASE_URL', '/horizon/');
    const anchors = captureAnchors();

    (await loadDslApi()).triggerDump();

    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute('href')).toBe('/horizon/api/dump');
  });

  it('prefixes the sub-path base onto a per-catalog dump', async () => {
    vi.stubEnv('BASE_URL', '/horizon/');
    const anchors = captureAnchors();

    (await loadDslApi()).triggerDump('otel-rules');

    expect(anchors[0].getAttribute('href')).toBe('/horizon/api/dump/otel-rules');
    // The bug this guards: a root-relative href escapes the base and the
    // gateway hands it to whatever else owns `/api` at the root.
    expect(anchors[0].getAttribute('href')).not.toBe('/api/dump/otel-rules');
  });

  it('stays root-relative when served from the root', async () => {
    vi.stubEnv('BASE_URL', '/');
    const anchors = captureAnchors();

    (await loadDslApi()).triggerDump('lal');

    expect(anchors[0].getAttribute('href')).toBe('/api/dump/lal');
  });
});
