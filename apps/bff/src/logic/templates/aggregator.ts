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
 * Bridges the per-kind bundled loaders (layers loader, overview loader,
 * alert bundled file) into the sync orchestrator's `BundledTemplate`
 * iterator. One function, three callsites — keeps the orchestrator from
 * importing each loader directly.
 *
 * Re-reads every call so the layer-template fs.watch + overview cache
 * invalidation pick up edits without requiring an orchestrator restart.
 */

import { allLayerTemplates } from '../layers/loader.js';
import { loadOverviewDashboards } from '../overview/loader.js';
import { loadBundledAlertPageSetup } from '../alarms/bundled.js';
import {
  loadBundledThemeActive,
  loadBundledTimeDefaults,
} from './global-defaults-bundled.js';
import {
  ALERT_PAGE_SETUP_KEY,
  THEME_ACTIVE_KEY,
  TIME_DEFAULTS_KEY,
  type TemplateKind,
} from './names.js';
import type { BundledTemplate } from './sync.js';

export function* iterateBundledTemplates(): IterableIterator<BundledTemplate> {
  for (const tpl of allLayerTemplates()) {
    yield { kind: 'layer' satisfies TemplateKind, key: tpl.key, content: tpl };
  }
  for (const dash of loadOverviewDashboards()) {
    yield { kind: 'overview' satisfies TemplateKind, key: dash.id, content: dash };
  }
  yield {
    kind: 'alert' satisfies TemplateKind,
    key: ALERT_PAGE_SETUP_KEY,
    content: loadBundledAlertPageSetup(),
  };
  yield {
    kind: 'theme' satisfies TemplateKind,
    key: THEME_ACTIVE_KEY,
    content: loadBundledThemeActive(),
  };
  yield {
    kind: 'time-defaults' satisfies TemplateKind,
    key: TIME_DEFAULTS_KEY,
    content: loadBundledTimeDefaults(),
  };
}
