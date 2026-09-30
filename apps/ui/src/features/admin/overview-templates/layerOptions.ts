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

import { parseEntryKey, widgetLayerEntry, widgetLayerOf } from '@/utils/layerRoute';

/** A menu entry as a widget stores its layer: `GENERAL`, or one group of a
 *  split layer, `GENERAL[payments]`; null for a group the notation cannot
 *  write, which is not offered rather than saved as another. */
export function widgetLayerKey(menuKey: string): string | null {
  return widgetLayerOf(parseEntryKey(menuKey));
}

/** A draft's stored layer as the options list it; one that names no entry is
 *  listed as written, so the widget still shows what it holds. */
function storedOption(stored: string): string {
  const ref = widgetLayerEntry(stored);
  return (ref && widgetLayerOf(ref)) ?? stored;
}

/** Every layer the menu knows, with or without services now — a quiet layer
 *  (VIRTUAL_GENAI on a deployment with no AI traffic yet) can still be given a
 *  widget — plus any layer the draft already references. */
export function overviewLayerOptions(
  menuKeys: readonly string[],
  draftLayers: readonly (string | undefined)[],
): string[] {
  const known = new Set<string>();
  for (const key of menuKeys) {
    // A split layer is offered whole as well as by each group.
    known.add(parseEntryKey(key).layer.toUpperCase());
    const entry = widgetLayerKey(key);
    if (entry !== null) known.add(entry);
  }
  for (const l of draftLayers) if (l) known.add(storedOption(l));
  return [...known].sort();
}
