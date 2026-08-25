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
 * Facts about the fixture that specs assert against. Kept in one place so a
 * compose change (a renamed demo service, a different account) lands in a
 * single file rather than across every spec.
 *
 * The credentials mirror `test/e2e/env` — the compose stack is the source of
 * truth, these are the defaults it ships with.
 */

export const E2E_USER = process.env.HORIZON_E2E_USER ?? 'e2e';
export const E2E_PASSWORD = process.env.HORIZON_E2E_PASSWORD ?? 'e2e-passw0rd';

/**
 * The API token the core case mounts (`script/docker-compose/e2e-tokens.json`).
 *
 * A throwaway secret in a throwaway stack, committed on purpose so the spec
 * and the fixture cannot drift — token usage is reported per token id, and the
 * assertion needs to know which id to look for.
 */
export const E2E_TOKEN_ID = 'e2etok';
export const E2E_TOKEN = `hzn_${E2E_TOKEN_ID}_e2e-token-secret-do-not-reuse`;

/** Service names the instrumented demo app reports to OAP. */
export const PROVIDER_SERVICE = 'e2e-service-provider';
export const CONSUMER_SERVICE = 'e2e-service-consumer';

/**
 * Endpoints the demo app serves. `/users` is the consumer -> provider call the
 * `trigger` block drives continuously (it is what produces the topology);
 * `/logs/trigger` is the log-emitting endpoint seeded once at setup.
 *
 * Assertions match against this SET rather than one member: which endpoint
 * owns the newest page of traces depends on traffic mix, so pinning one makes
 * a correct build fail on timing.
 */
export const DEMO_ENDPOINTS = ['/users', '/logs/trigger'];

/**
 * The layer the Java agent's services land in. Everything the core fixture
 * produces is GENERAL — a case that needs MESH or K8S_SERVICE needs a
 * different fixture, not a different assertion here.
 */
export const LAYER = 'general';

/**
 * A disposable layer that exists ONLY in the browser, for the authoring
 * tests that do not need a live service roster.
 *
 * Horizon has no control that creates a layer: the admin's picker is the
 * shipped templates, the templates stored on OAP, and the layers OAP
 * reports services for. So this one is seeded into the operator's own
 * local-draft store and viewed through preview mode, which injects a
 * previewed layer the live menu does not list. Nothing about it reaches
 * OAP, and it dies with the browser context.
 */
export const EXT_LAYER = 'e2e_ext';

/** The localStorage key the local-draft store reads. */
export const LOCAL_EDITS_KEY = 'horizon:localTemplateEdits:v1';

/** Seed content for {@link EXT_LAYER}. It declares all three entity
 *  components so pages can be authored under each, and carries one widget
 *  so its default grid is distinguishable from an empty page. */
export const EXT_LAYER_DRAFT = {
  key: EXT_LAYER.toUpperCase(),
  alias: 'E2E ext pages',
  color: '#f97316',
  slots: {},
  metrics: {},
  components: { service: true, instances: true, endpoints: true },
  dashboards: {
    service: [
      { id: 'e2e-svc-load', type: 'line', title: 'Load', expressions: ['service_cpm'], span: 6, rowSpan: 2 },
    ],
  },
};

/**
 * Widest window the suite ever asks for. The fixture is minutes old, so a
 * longer window buys nothing and a shorter one races the metrics boundary.
 */
export const WINDOW_MINUTES = 30;

/**
 * The istio fixture. bookinfo's services reach OAP as MESH entities analysed
 * from Envoy access logs — no agent is involved, which is what the `istio`
 * case exists to cover.
 *
 * `mesh_dp` is a separate layer holding the Envoy data-plane dashboards; its
 * instance scope is the only bundled template the suite reaches that declares
 * `card` widgets.
 */
export const MESH_LAYER = 'mesh';

/**
 * bookinfo's workloads as MESH services. Matched as a SET, never pinned to
 * one: which service the layer header auto-resolves follows OAP's ordering,
 * so naming a single one fails on a healthy mesh whenever traffic shifts.
 *
 * `ratings` is deliberately absent. Only reviews-v2 and v3 call it, so
 * whether it has appeared yet depends on which reviews version the traffic
 * happened to reach — true of a healthy mesh, and not something to assert.
 */
export const MESH_PEERS = ['productpage', 'reviews', 'details'];

/**
 * EVERY service this fixture's mesh can produce: all four bookinfo workloads
 * plus the ingress gateway bookinfo is reached through, which ALS reports
 * like any other mesh workload.
 *
 * Distinct from MESH_PEERS on purpose. `ratings` is reached only via
 * reviews-v2/v3, so whether it exists in a given window depends on which
 * review version the traffic hit — it cannot be REQUIRED to be listed, but it
 * can certainly be the one the header resolves to. Which service that is
 * follows OAP's ordering and changes between runs, so anything asserting on
 * the SELECTED service must accept the full set.
 */
export const MESH_SERVICES = [...MESH_PEERS, 'ratings', 'istio-ingressgateway'];

/**
 * The SAME workload in the MESH_DP layer, which names services
 * `<workload>.<namespace>`. ALS produces both sets, and they are not
 * interchangeable: the request metrics hang off the MESH service, Envoy's own
 * stats off this one — and those are instance-scoped, one Envoy per pod.
 */
export const MESH_DP_LAYER = 'mesh_dp';
/** MESH_DP names services `<workload>.<namespace>`; bookinfo runs in default. */
export const MESH_DP_SUFFIX = '\\.default';

/**
 * The deployment fixture: BanyanDB running as a CLUSTER, reporting its own
 * observability through FODC.
 *
 * The service name is the `cluster` label the OTel collector injects — OAP's
 * banyandb rules build the BANYANDB service from it, so it is fixture
 * configuration rather than anything BanyanDB chooses.
 *
 * The roles come from the `node_role` attribute on those samples. A clustered
 * install has more than one; a standalone node would have nothing to group.
 */
export const BANYANDB_LAYER = 'banyandb';
export const BANYANDB_CLUSTER = 'e2e-banyandb';
export const BANYANDB_ROLES = ['liaison', 'data'];
