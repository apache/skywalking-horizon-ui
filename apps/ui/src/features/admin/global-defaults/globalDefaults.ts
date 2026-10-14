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

/** 31 days — the ceiling the time-defaults template is published under. */
export const MAX_DEFAULT_WINDOW_MINUTES = 60 * 24 * 31;

/** Why a default-window value cannot be saved, or null when it can. The
 *  custom input hands back '' once cleared, and fractions as typed. */
export function windowMinutesProblem(v: unknown): 'range' | 'whole' | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > MAX_DEFAULT_WINDOW_MINUTES) return 'range';
  return Number.isInteger(v) ? null : 'whole';
}

/** The values one Save writes — a field only when its section changed — or
 *  null when either section holds a value the push would refuse. Both are
 *  checked before anything is written, so a Save never lands one section
 *  and fails the other on input. */
export function planGlobalDefaultsSave<T extends string>(
  draft: { themeId: T; minutes: unknown },
  orig: { themeId: T; minutes: number },
  isTheme: (id: string) => boolean,
): { themeId?: T; minutes?: number } | null {
  const { themeId, minutes } = draft;
  if (!isTheme(themeId) || typeof minutes !== 'number' || windowMinutesProblem(minutes) !== null) return null;
  return {
    ...(themeId !== orig.themeId ? { themeId } : {}),
    ...(minutes !== orig.minutes ? { minutes } : {}),
  };
}
