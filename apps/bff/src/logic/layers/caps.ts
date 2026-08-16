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
 * A layer template's `components` flags as the wire `caps` every consumer
 * reads.
 *
 * ONE copy, deliberately. This rule decides which rows a layer exposes, so
 * a second copy that drifts does not fail loudly — it renders a menu that
 * disagrees with the one beside it. That has already happened once between
 * the BFF and the browser, where an absent `service` flag read as ON in
 * one and OFF in the other.
 */

import type { LayerCaps } from '@skywalking-horizon-ui/api-client';
import type { LayerComponentFlags, LayerTemplate } from './loader.js';

/**
 * Map the JSON config's `components.*` flags onto the wire `caps`
 * shape — caps are the cap-driven feature toggles each per-layer page
 * consults. We expand a few aliases (service ⇒ no separate cap; the
 * components flag is the source of truth for whether the page exists).
 */
export function componentsToCaps(components: LayerComponentFlags): LayerCaps {
  return {
    dashboards: components.service !== false,
    instances: !!components.instances,
    endpoints: !!components.endpoints,
    endpointDependency: !!components.endpointDependency,
    serviceMap: !!components.topology,
    // instanceTopology is gated by the presence of the
    // topology.instanceTopology config block, not the component flag —
    // overridden per-layer at the call site (see resolveLayerDef).
    instanceTopology: false,
    // deployment rides the component flag here; the call site
    // ANDs it with the presence of the top-level config block.
    deployment: !!components.deployment,
    processTopology: !!components.topology,
    traces: !!components.traces,
    logs: !!components.logs,
    browserErrors: !!components.browserErrors,
    traceProfiling: !!components.traceProfiling,
    ebpfProfiling: !!components.ebpfProfiling,
    asyncProfiling: !!components.asyncProfiling,
    networkProfiling: !!components.networkProfiling,
    pprofProfiling: !!components.pprofProfiling,
    continuousProfiling: !!components.continuousProfiling,
    podLogs: !!components.podLogs,
    events: false,
  };
}

/**
 * A template's component flags as wire `caps`, including the two that are
 * gated on a config block rather than on their own flag.
 *
 * `localized` supplies the flags; `raw` supplies the config blocks, which
 * translation never touches. Exported so the row-resolution regression
 * test can build the same caps the menu serves rather than an
 * approximation of them.
 */
export function capsForTemplate(
  localized: LayerTemplate,
  raw: LayerTemplate | null,
): LayerCaps {
  const c = componentsToCaps(localized.components);
  // Read the EFFECTIVE (remote) template — the same one the topology
  // routes serve — so the Instance-map drill-down is available iff it's
  // enabled on the in-use template, matching the admin. Gate on the parent
  // Topology component (`serviceMap` = `components.topology`): instance
  // topology is a drill-down OF the topology map, so disabling the
  // Topology component must hide it too — even if a stale
  // `topology.instanceTopology` block lingers.
  c.instanceTopology = c.serviceMap && !!raw?.topology?.instanceTopology;
  // Deployment is its own tab (not a drill-down of the service map), so
  // it's gated only on its own config block presence AND its component
  // flag — independent of `serviceMap`.
  c.deployment = c.deployment && !!raw?.deployment;
  return c;
}
