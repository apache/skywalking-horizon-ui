// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements.  See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { ref, watch, type Ref } from 'vue';

const STORAGE_KEY = 'horizon:profile:hideFrames:v1';

function readStored(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

const patterns = ref<string[]>(readStored());
watch(patterns, (next) => {
  try {
    if (next.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage blocked — the list lasts until the page reloads */
  }
});

/** The frame patterns the stack views hide, kept in this browser so an
 *  operator does not retype them for every analyze. One list for the page and
 *  its pop-out, so a change in either shows in both. */
export function useHiddenFramePatterns(): Ref<string[]> {
  return patterns;
}
