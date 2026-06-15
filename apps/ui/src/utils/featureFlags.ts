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
 * Build-/runtime feature flags. Evaluated ONCE at module load and frozen
 * as `const` booleans so unused branches tree-shake out of the prod
 * bundle when off.
 *
 * `FF_ENTITY_COMPARE` gates the multi-entity lock + cross-check preview.
 * Enable per build with `VITE_FF_ENTITY_COMPARE=1`, or per browser for
 * dogfooding without a rebuild via
 * `localStorage['horizon:ff:entity-compare'] = '1'` (then reload).
 */

const FLAG_KEY = 'horizon:ff:entity-compare';

/** Pure evaluator — exported for unit tests; not used directly by app
 *  code (which reads the frozen `FF_ENTITY_COMPARE` below). */
export function __evalEntityCompareFlag(
  envValue: string | undefined,
  lsValue: string | null,
): boolean {
  const truthy = (v: string | null | undefined): boolean => v === '1' || v === 'true';
  return truthy(envValue) || truthy(lsValue);
}

function readLocalStorage(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    // Private-mode / disabled storage — treat as unset.
    return null;
  }
}

export const FF_ENTITY_COMPARE: boolean = __evalEntityCompareFlag(
  import.meta.env.VITE_FF_ENTITY_COMPARE as string | undefined,
  readLocalStorage(FLAG_KEY),
);
