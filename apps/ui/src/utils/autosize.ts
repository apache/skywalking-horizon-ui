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
 * Vue directive: grow a `<textarea>` so its visible height matches its
 * content. Uses the standard "set height to 0, then to scrollHeight"
 * trick. Listens on `input` and re-measures whenever the bound value
 * updates so programmatic value changes (locale switches, draft
 * seeding) resize too.
 *
 *   <textarea v-autosize="draftValue" :value="draftValue" />
 *
 * The bound expression is purely a re-measure trigger — the actual
 * value still binds via :value / @input.
 */

import type { Directive } from 'vue';

function fit(el: HTMLTextAreaElement): void {
  // When the textarea is empty, measure with the placeholder text
  // copied in so the height still fits the prompt the operator is
  // expected to translate (a 4-line EN source shouldn't collapse to
  // a 1-line input). The swap happens between layout writes so the
  // browser doesn't paint the intermediate value.
  const wasEmpty = el.value.length === 0;
  const placeholder = el.placeholder;
  if (wasEmpty && placeholder) el.value = placeholder;
  el.style.height = '0px';
  el.style.height = `${el.scrollHeight + 2}px`;
  if (wasEmpty && placeholder) el.value = '';
}

export const vAutosize: Directive<HTMLTextAreaElement, unknown> = {
  mounted(el) {
    el.style.overflow = 'hidden';
    el.style.resize = 'none';
    // Defer one frame so the element is laid out before measuring.
    requestAnimationFrame(() => fit(el));
    el.addEventListener('input', () => fit(el));
  },
  updated(el) {
    requestAnimationFrame(() => fit(el));
  },
};
