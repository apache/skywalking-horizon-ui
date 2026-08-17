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
 * The instance set an extension page is about.
 *
 * Two conditions, ANDed: the name, with exactly the grammar the service
 * filter uses (shared matcher, so they cannot drift), and any number of
 * attribute conditions evaluated through the shared attribute map — the
 * same one a widget's `visibleWhen: { kind: 'entity' }` gate uses, so
 * `exists` means the same thing in both places.
 *
 * Like the service filter this is CONFIGURATION: it narrows the list the
 * operator sees and is never shown to them. The page's name is what says
 * what it holds.
 */

import { attrPredicatesPass, buildAttrMap, type InstanceAttributePredicate } from '@skywalking-horizon-ui/api-client';
import { serviceFilterMatcher } from '@/layer/serviceFilter';
import type { LayerInstance } from './useInstanceCascade';

export interface InstancePageFilter {
  instanceFilter?: string;
  instanceAttributes?: InstanceAttributePredicate[];
}

/** True when the page declares nothing — the common case, and worth a
 *  fast path because it means every instance passes. */
export function isEmptyInstanceFilter(f: InstancePageFilter | null | undefined): boolean {
  return !f || (!f.instanceFilter && (f.instanceAttributes ?? []).length === 0);
}

export function instancePageMatcher(
  f: InstancePageFilter | null | undefined,
): (i: LayerInstance) => boolean {
  if (isEmptyInstanceFilter(f)) return () => true;
  const byName = serviceFilterMatcher(f?.instanceFilter ?? '');
  const preds = f?.instanceAttributes ?? [];
  return (i) => {
    if (!byName.match(i.name)) return false;
    if (preds.length === 0) return true;
    return attrPredicatesPass(preds, buildAttrMap(i.language, i.attributes));
  };
}
