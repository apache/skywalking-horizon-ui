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
 * Per-service events popout coordinator. Events are a single-service peek, so
 * they open as an in-context modal — the operator stays on the layer they were
 * reading and sees just that service's instances, with no separate page to
 * navigate to.
 *
 * Any place with a `(layerKey, serviceName)` calls `open(...)`; the popout
 * component (`EventsPopout.vue`, mounted once in `AppShell`) reacts. State is a
 * module-level ref so caller and popout share one target without prop drilling.
 */

import { readonly, ref, type DeepReadonly, type Ref } from 'vue';

export interface EventsPopoutTarget {
  /** Lowercase layer key (the BFF uppercases it for OAP). */
  layer: string;
  /** Full OAP service NAME (events filter on the literal name). */
  service: string;
}

const target = ref<EventsPopoutTarget | null>(null);

export function useEventsPopout(): {
  target: DeepReadonly<Ref<EventsPopoutTarget | null>>;
  open: (layer: string, service: string) => void;
  close: () => void;
} {
  return {
    target: readonly(target),
    open: (layer: string, service: string): void => {
      if (!layer || !service) return;
      target.value = { layer, service };
    },
    close: (): void => {
      target.value = null;
    },
  };
}
