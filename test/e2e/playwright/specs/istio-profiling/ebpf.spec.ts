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

import { test, expect } from '../support/diagnostics.js';
import { MESH_LAYER, MESH_PEERS } from '../fixture.js';

// Profiling pages, which exist only where rover does.
//
// Kept in their OWN project rather than alongside mesh.spec.ts so a run with
// E2E_SKIP_PROFILING set omits them by not invoking this project at all —
// rather than starting a browser to skip inside it.
//
// SCOPE, deliberately: these assert the pages MOUNT and resolve a service.
// They do NOT open the process picker, assert any process, create a task, or
// read a profiling result — so a broken process-query or binding path would
// still pass them. The profiling COMPONENTS are untested for now; what these
// buy is that the routes resolve and the views do not throw on mount against
// a deployment where rover is running.
//
// The readiness check beside them is what proves rover reported anything at
// all; it asks OAP directly.

test('the eBPF profiling page mounts and resolves a service', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${MESH_LAYER}/ebpf-profiling`);

  await expect(page.locator('.sw-card').first()).toBeVisible({ timeout: 60_000 });
  // Resolving a service is as far as this goes — see the scope note above.
  // Matched as a set: which one the header lands on is OAP's ordering, not
  // ours.
  const selected = page.locator('.service-row .svc-name');
  await expect(selected).toBeVisible({ timeout: 60_000 });
  await expect(selected).toHaveText(new RegExp(`^(${MESH_PEERS.join('|')})$`));

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('the network profiling page mounts', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${MESH_LAYER}/network-profiling`);

  await expect(page.locator('.sw-card').first()).toBeVisible({ timeout: 60_000 });

  expect(pageErrors).toEqual([]);
});
