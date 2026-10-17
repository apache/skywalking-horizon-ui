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
 * Copy text from a click, and say whether it was copied, so a caller shows
 * "copied" only when it is true.
 *
 * A browser has the Clipboard API only in a secure context, HTTPS or
 * localhost, and a self-hosted Horizon is often plain HTTP on an intranet
 * address. Without the API, the copy goes through a hidden text area and
 * `execCommand('copy')` at once, inside the click, which is the user
 * activation that command needs. When the API is there and refuses, the same
 * fallback runs once it has answered, which the browser allows only while the
 * click's activation lasts. The conversation renderer copies the same way.
 */
export function copyText(value: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return Promise.resolve(copySelection(value));
  return navigator.clipboard.writeText(value).then(
    () => true,
    () => copySelection(value),
  );
}

function copySelection(value: string): boolean {
  if (typeof document === 'undefined') return false;
  const focused = document.activeElement;
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    // Selecting the text area took the focus; give it back, so a copy from a
    // dialog leaves the keyboard where it was.
    if (focused instanceof HTMLElement && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }
}
