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

import { onBeforeUnmount, onMounted, watch } from 'vue';

/**
 * Close a dismissible box (popout / modal / drawer / side panel / popover)
 * on the Escape key — the keyboard counterpart to its × / backdrop click.
 *
 * Pass an `isOpen` getter so the listener is a no-op while the box is shut
 * (and so it reads the LATEST open state on every keypress — a prop, a
 * ref, a store flag); `close` runs only when open.
 *
 *   useEscapeToClose(() => props.show, () => emit('close'));
 *   useEscapeToClose(() => openStage.value !== null, () => (openStage.value = null));
 *
 * ONE Escape closes ONE box, the innermost. Every box registers here and a
 * single listener picks the one opened MOST RECENTLY, so a value popout over
 * a span dialog over a trace popout unwinds a layer per keypress. Each box
 * having its own window listener meant one keypress closed the whole stack:
 * the inner box handled it and every outer box handled it too.
 *
 * Mount order cannot decide this — a child registers BEFORE its parent — so
 * what is tracked is when each box last became open.
 *
 * TWO BOXES CAN OPEN IN THE SAME UPDATE, and then nothing opened "last": a
 * link naming a span opens a trace the query cache already holds, so the
 * popout and the span panel inside it become open together. Ties fall back to
 * the order the boxes were REGISTERED, so a component owning both layers must
 * declare the OUTER one first — otherwise that keypress closes the trace and
 * takes the span panel with it.
 */

interface Box {
  isOpen: () => boolean;
  close: () => void;
  /** When this box last opened. Highest among the open boxes is innermost. */
  openedAt: number;
}

const boxes = new Set<Box>();
let opens = 0;
let listening = false;

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  let top: Box | null = null;
  for (const b of boxes) {
    if (!b.isOpen()) continue;
    if (!top || b.openedAt > top.openedAt) top = b;
  }
  top?.close();
}

export function useEscapeToClose(isOpen: () => boolean, close: () => void): void {
  const box: Box = { isOpen, close, openedAt: 0 };
  watch(
    isOpen,
    (open) => {
      if (open) {
        opens += 1;
        box.openedAt = opens;
      }
    },
    { immediate: true },
  );
  onMounted(() => {
    boxes.add(box);
    if (!listening) {
      window.addEventListener('keydown', onKey);
      listening = true;
    }
  });
  onBeforeUnmount(() => {
    boxes.delete(box);
    if (boxes.size === 0 && listening) {
      window.removeEventListener('keydown', onKey);
      listening = false;
    }
  });
}
