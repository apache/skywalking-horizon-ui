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
 * One Zipkin trace id as OAP looks it up — Zipkin's `Span.normalizeTraceId`:
 * lower-case hex (OAP refuses upper case), left-padded to 16 or 32 digits, and
 * an id whose high half is then zero shortened to its low 16. Shortening AFTER
 * the padding keeps the result a fixed point of OAP's own normalization, which
 * runs again on what it receives — otherwise `0463…` and `463…` would be two
 * ids here and one to OAP. `null` when the value is not a trace id. Shared so
 * the page shows an id exactly as it is looked up.
 */
export function normalizeZipkinTraceId(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!/^[0-9a-f]{1,32}$/.test(v) || /^0+$/.test(v)) return null;
  const padded = v.padStart(v.length <= 16 ? 16 : 32, '0');
  return padded.length === 32 && padded.startsWith('0'.repeat(16)) ? padded.slice(16) : padded;
}
