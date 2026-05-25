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
 * BFF i18n public surface — types, merge, store, request locale.
 * Internal modules (seed / validate / translate CLIs) import the
 * submodules directly.
 */

export type { Locale } from './types.js';
export {
  SUPPORTED_LOCALES,
  OVERLAY_LOCALES,
  LOCALE_NATIVE_LABEL,
  isLocale,
} from './types.js';
export { localize, localizeContent, mergeLocalizedNode } from './merge.js';
export {
  getLayerOverlay,
  getOverviewOverlay,
  lookupLexicon,
  lexiconForLocale,
  parseOverlayFilename,
  isOverlayFilename,
  reloadI18nStore,
} from './store.js';
export { localeFromRequest } from './request.js';
