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

/** The route segment for a layer or sidebar entry key: the layer lower-cased,
 *  as routes spell it, and a service group after `~` kept as written — the
 *  BFF compares groups exactly. */
export function layerRouteKey(key: string): string {
  const cut = key.indexOf('~');
  return cut < 0 ? key.toLowerCase() : `${key.slice(0, cut).toLowerCase()}${key.slice(cut)}`;
}
