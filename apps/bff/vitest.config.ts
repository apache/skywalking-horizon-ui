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

import { defaultExclude, defineConfig } from 'vitest/config';

/**
 * The unit suite. Integration tests share the `.test.ts` suffix so they sit
 * beside the code they cover, which means the exclude below is what keeps them
 * out of `pnpm test:unit` — they need a running BanyanDB and would otherwise
 * fail every local build. `vitest.it.config.ts` selects them instead.
 */
export default defineConfig({
  test: { exclude: [...defaultExclude, '**/*.it.test.ts'] },
});
