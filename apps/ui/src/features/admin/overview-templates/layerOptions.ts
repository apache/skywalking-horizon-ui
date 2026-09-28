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

/** A widget's layer as the editor offers it: the layer key upper-cased, and
 *  a split entry's `~group` kept as written, because the group reaches OAP as
 *  the service group and OAP groups are case-sensitive. */
export function widgetLayerKey(key: string): string {
  const cut = key.indexOf('~');
  return cut < 0 ? key.toUpperCase() : `${key.slice(0, cut).toUpperCase()}${key.slice(cut)}`;
}

/** Every layer the menu knows, with or without services now — a quiet layer
 *  (VIRTUAL_GENAI on a deployment with no AI traffic yet) can still be given a
 *  widget — plus any layer the draft already references. */
export function overviewLayerOptions(
  menuKeys: readonly string[],
  draftLayers: readonly (string | undefined)[],
): string[] {
  const known = new Set(menuKeys.map(widgetLayerKey));
  for (const l of draftLayers) if (l) known.add(widgetLayerKey(l));
  return [...known].sort();
}
