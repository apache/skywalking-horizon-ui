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
 * SHA-256 (lowercase hex) of a rule's content — matches OAP's
 * `ContentHash.sha256Hex` (UTF-8 bytes) so it can stand in as the durable
 * identity when polling `/runtime/rule/status` after the applyId is gone
 * (the page-reload resume path).
 *
 * Best-effort: `crypto.subtle` only exists in a secure context (https /
 * localhost). When the UI is reached over plain http by IP/hostname it is
 * undefined, so we return `''` rather than throw — the apply is then tracked
 * by `applyId` alone (which works for the live session; only reload-resume
 * after a long gap degrades). Never let a hash failure abort apply tracking.
 */
export async function sha256Hex(content: string): Promise<string> {
  try {
    if (!globalThis.crypto?.subtle) return '';
    const bytes = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return '';
  }
}
