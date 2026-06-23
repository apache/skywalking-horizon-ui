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

import type { LogRow } from '@/api/client';

/** Stable per-row key for the shared log stream. Shared by LogStreamPanel
 *  and its hosts so a host's `selectedKey` lines up with the panel's rows.
 *  Timestamp + trace id + index disambiguate rows that share a timestamp. */
export function logRowKey(r: LogRow, idx: number): string {
  return `${r.timestamp}-${r.traceId ?? ''}-${idx}`;
}
