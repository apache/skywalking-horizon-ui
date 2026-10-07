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

import { ref, watch, type Ref } from 'vue';

/** What a click on a log row does: expand it in place, or open the popout. */
export type LogOpenMode = 'inline' | 'popout';

const STORAGE_KEY = 'horizon:log-open-mode';

function readStored(): LogOpenMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'popout' ? 'popout' : 'inline';
  } catch {
    return 'inline';
  }
}

const mode = ref<LogOpenMode>(readStored());
watch(mode, (next) => {
  try {
    if (next === 'popout') localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage blocked — the choice lasts until the page reloads */
  }
});

/** The viewer's choice for every log stream, kept in this browser, so
 *  flipping it on one page applies on the others. */
export function useLogOpenMode(): Ref<LogOpenMode> {
  return mode;
}
