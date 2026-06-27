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

import { onBeforeUnmount, onMounted } from 'vue';

/**
 * Close a dismissible box (popout / modal / drawer / side panel / popover)
 * on the Escape key — the keyboard counterpart to its × / backdrop click.
 *
 * Pass an `isOpen` getter so the listener is a no-op while the box is shut
 * (and so it reads the LATEST open state on every keypress — a prop, a
 * ref, a store flag); `close` runs only when open. The window listener is
 * torn down on unmount.
 *
 *   useEscapeToClose(() => props.show, () => emit('close'));
 *   useEscapeToClose(() => openStage.value !== null, () => (openStage.value = null));
 *
 * Boxes that nest another dismissible box (a span panel inside a trace
 * popout) own a bespoke two-level handler instead — this is for the common
 * single-level case.
 */
export function useEscapeToClose(isOpen: () => boolean, close: () => void): void {
  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (!isOpen()) return;
    close();
  }
  onMounted(() => window.addEventListener('keydown', onKey));
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
}
