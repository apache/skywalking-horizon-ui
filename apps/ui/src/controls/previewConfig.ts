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
 * Forward an operator's unpublished draft config block to the BFF in
 * preview mode.
 *
 * Pages that fetch a SINGLE template-driven config directly from the BFF
 * (topology, endpoint-dependency, traces, network-profiling) resolve the
 * REMOTE template server-side, so they ignore a local draft unless the UI
 * hands the draft over. This composable produces a reactive JSON string of
 * the previewed layer template's `<block>` — `undefined` outside preview
 * mode or when there's no draft — for passing to that route's
 * `previewConfig` arg. Including it in the route's queryKey makes the page
 * re-render when the operator edits + re-previews. Mirrors how the config
 * bundle already overlays drafts for the dashboard / overview list views.
 */

import { computed, type ComputedRef } from 'vue';
import { usePreviewMode } from '@/controls/previewMode';
import { getPreviewContentFor } from '@/controls/configBundle';
import { layerEditName } from '@/controls/localTemplateEdits';

export type PreviewBlock =
  | 'topology'
  | 'endpointDependency'
  | 'traces'
  | 'processTopology';

export function usePreviewLayerBlock(
  layerKey: ComputedRef<string> | { value: string },
  block: PreviewBlock,
): ComputedRef<string | undefined> {
  const previewMode = usePreviewMode();
  return computed<string | undefined>(() => {
    if (!previewMode.value) return undefined;
    const tpl = getPreviewContentFor<Record<string, unknown>>(layerEditName(layerKey.value));
    const cfg = tpl?.[block];
    return cfg ? JSON.stringify(cfg) : undefined;
  });
}
