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

// Flat config for ESLint 9. UI = Vue 3 + TypeScript + JSX.
import pluginVue from 'eslint-plugin-vue';
import vueTsEslintConfig from '@vue/eslint-config-typescript';
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting';

export default [
  {
    ignores: ['dist/**', 'dist-mcp-app/**', 'node_modules/**', 'coverage/**', 'public/**', '*.cjs'],
  },
  ...pluginVue.configs['flat/essential'],
  ...vueTsEslintConfig(),
  skipFormatting,
  {
    rules: {
      'vue/multi-word-component-names': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // File-size guardrail. No file may exceed 2000 lines of code (comments
    // and blank lines excluded) — split it (extract composables /
    // sub-components) instead.
    files: ['src/**/*.vue', 'src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.d.ts'],
    rules: { 'max-lines': ['error', { max: 2000, skipComments: true, skipBlankLines: true }] },
  },
  {
    // Markup and script sinks. `flat/essential` does not carry
    // `vue/no-v-html`, so every one of these could be introduced without a
    // reviewer being told — which is how a dashboard-config value reaches an
    // HTML string. Each existing use is legitimate and now says so with an
    // explicit disable line, so the next one has to argue for itself.
    // Rendering data belongs in `{{ }}`, d3 `.text()`, or the shared escaper.
    files: ['src/**/*.vue', 'src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.d.ts'],
    rules: {
      'vue/no-v-html': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // A string literal is developer-authored; anything else carries a
          // value from somewhere, and `host.innerHTML = ''` (clearing a d3
          // host before re-render) stays legal.
          selector: "AssignmentExpression[left.property.name='innerHTML'][right.type!='Literal']",
          message:
            'innerHTML with a computed value is an HTML sink — render through {{ }}, d3 .text(), or escape it.',
        },
        {
          // `el['innerHTML'] = x` reaches the same setter but parses as a
          // COMPUTED member, where the key is `property.value`, not
          // `property.name` — so the selector above never saw it.
          selector:
            "AssignmentExpression[left.computed=true][left.property.value='innerHTML'][right.type!='Literal']",
          message:
            'innerHTML with a computed value is an HTML sink — render through {{ }}, d3 .text(), or escape it.',
        },
        {
          // `Object.assign(el, { innerHTML: x })` assigns it without ever
          // writing an AssignmentExpression.
          selector:
            "CallExpression[callee.object.name='Object'][callee.property.name='assign'] Property[key.name=/^(innerHTML|outerHTML)$/]",
          message:
            'assigning innerHTML/outerHTML through Object.assign is an HTML sink — build the node instead.',
        },
        {
          selector: "AssignmentExpression[left.property.name='outerHTML']",
          message: 'outerHTML is an HTML sink — build the node instead.',
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML is an HTML sink — build the node instead.',
        },
        {
          selector: "CallExpression[callee.object.name='document'][callee.property.name='write']",
          message: 'document.write is an HTML sink and blocks parsing.',
        },
      ],
    },
  },
];
