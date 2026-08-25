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
 * Turns an {@link EffectiveLayerReason} into the sentence a tool returns when
 * it has no metrics to show.
 *
 * The distinction is load-bearing rather than cosmetic. "No metrics" and
 * "cannot read metrics" look identical in an empty array, and an agent that
 * conflates them tells an operator their layer is empty during an OAP outage —
 * a confident falsehood about production, worse than an error. Each message
 * therefore names the blast radius and what to do next, and the two that mean
 * "Horizon is broken" say so in terms an operator can act on.
 */

import type { EffectiveLayerReason } from '../../../../logic/layers/effective.js';

export function explainEmptyCatalog(reason: EffectiveLayerReason, layer: string, scope?: string): string {
  const at = scope ? `layer "${layer}" at scope "${scope}"` : `layer "${layer}"`;
  switch (reason) {
    case 'store-unreachable':
      return (
        `Cannot read metrics: Horizon reached no template store — OAP's admin endpoint is unreachable. ` +
        `This affects EVERY layer, not just ${layer}: no metric catalog, and therefore no metric figure or dashboard, can be read until it recovers. ` +
        `Alarms, traces, logs and topology come from OAP's QUERY port and still work — so investigate with those and say which half is unavailable. ` +
        `This is an OAP health problem, not an empty layer. Do not retry other layers; every one will answer the same. ` +
        `Call check_horizon_health for the detail to give the operator.`
      );
    case 'layer-disabled':
      return (
        `Cannot read metrics: an administrator disabled the template for ${at}. ` +
        `Deliberate and specific to this layer — other layers are unaffected. ` +
        `Say so rather than reporting the layer as empty; an administrator re-enables it in the Layer Dashboards admin page.`
      );
    case 'no-remote-row':
      return (
        `Cannot read metrics: no template is synced for ${at}. ` +
        `The layer is reachable but Horizon holds no readable template for it — unsynced, or not one Horizon ships. ` +
        `Other layers are unaffected. Try a layer from list_layers rather than assuming this one is idle.`
      );
    case 'read-error':
      return (
        `Cannot read metrics: reading the template for ${at} failed. ` +
        `Horizon knows nothing about this layer's metrics right now — this is not "the layer is empty" and not "the layer is unsynced". ` +
        `Call check_horizon_health, and report what it says rather than describing the layer.`
      );
    case 'ok':
      return `No metrics are defined for ${at}. The template was read successfully and carries none at this scope — try another scope, or another layer from list_layers.`;
  }
}
