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
 * Human-readable display labels for the four DSL catalogs.
 *
 * The catalog identifier (`otel-rules`, `telegraf-rules`, `log-mal-rules`,
 * `lal`) is the URL slug + the OAP wire identifier — it stays stable. But
 * operators don't read URL slugs; the page header should say "Metrics
 * Analysis Language - OpenTelemetry Rules" instead of "Catalog ·
 * otel-rules". The sidebar still abbreviates (MAL · OTEL, …) because
 * those rails are space-constrained.
 *
 * Caller pattern in templates:
 *   <h1>{{ t(catalogLabel(catalog)) }}</h1>
 * — the helper returns the *English* label, vue-i18n's Lingui-style
 * key === value lookup makes `t('Metrics Analysis Language - …')`
 * render that exact string under the English locale, and translators
 * can localize each by adding an entry to their catalog.
 */

import type { Catalog } from '@skywalking-horizon-ui/api-client';

export function catalogLabel(c: Catalog): string {
  switch (c) {
    case 'otel-rules':
      return 'Metrics Analysis Language - OpenTelemetry Rules';
    case 'telegraf-rules':
      return 'Metrics Analysis Language - Telegraf Rules';
    case 'log-mal-rules':
      return 'Metrics Analysis Language - Log MAL Rules';
    case 'lal':
      return 'Log Analysis Language';
  }
}
