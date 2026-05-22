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
 * Whether the current route is previewing unpublished template content
 * (`?mode=preview`), and from which source (`&source=local|bundled|remote`).
 * Browser-side template drafts (controls/localTemplateEdits) +
 * preview-overrides (controls/previewOverride) overlay live pages ONLY
 * while this is on. The router keeps it sticky across in-app (menu)
 * navigation and re-applies the query so the URL always reflects it —
 * see shell/router/index.ts. Normal viewing always renders remote.
 */

import { ref } from 'vue';

export type PreviewSource = 'local' | 'bundled' | 'remote';

const previewMode = ref(false);
const previewSource = ref<PreviewSource | null>(null);

export function setPreviewMode(on: boolean, source?: string | null): void {
  previewMode.value = on;
  if (!on) {
    previewSource.value = null;
    return;
  }
  if (source === 'local' || source === 'bundled' || source === 'remote') {
    previewSource.value = source;
  }
}

export function usePreviewMode(): typeof previewMode {
  return previewMode;
}
export function getPreviewSource(): PreviewSource | null {
  return previewSource.value;
}
