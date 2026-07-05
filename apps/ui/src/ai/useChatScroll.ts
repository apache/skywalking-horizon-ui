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

import { computed, nextTick, watch, type ComputedRef, type Ref } from 'vue';
import type { ChatMessage } from './types';

const TOP_PAD = 14; // px gap kept above the pinned user message

/**
 * Chat scroll behaviour: when the operator sends a message, pin THAT message to
 * the top of the scroll container and KEEP it there while the answer streams in
 * below — instead of following the tail to the bottom. Mirrors ChatGPT.
 *
 * How the pin holds: we re-assert the scroll position on every streamed tick
 * (the answer grows below, so this only corrects browser drift), and stop as
 * soon as the operator scrolls themselves — a real `wheel` / `touchmove`, which
 * programmatic scrolling never fires, so we tell the two apart cleanly and don't
 * fight them.
 *
 * Deliberately no bottom spacer: reserving room so a *short* answer could still
 * pin to the very top left trailing whitespace you'd scroll into ("it's gone"),
 * and the shrink-on-grow re-measure jumped the view mid-scroll. A short answer
 * fits the viewport anyway (nothing to pin), and a long one grows enough content
 * below the message to reach the top on its own.
 *
 * Resuming an existing conversation (switch) scrolls to the bottom so the latest
 * turn is visible; only a fresh send pins to the top.
 */
export function useChatScroll(opts: {
  container: Ref<HTMLElement | null>;
  messages: ComputedRef<ChatMessage[]>;
  /** Optional — re-scroll to the bottom when the active conversation changes. */
  conversationId?: ComputedRef<string | null>;
}): void {
  const { container, messages, conversationId } = opts;
  let prevUserCount = -1; // -1 so the first hydration doesn't read as "sent"
  let pinning = false; // actively holding the latest user message at the top

  function lastUserEl(): HTMLElement | null {
    const c = container.value;
    if (!c) return null;
    const els = c.querySelectorAll<HTMLElement>('.tx__msg.user');
    return els.length ? els[els.length - 1]! : null;
  }
  // Offset of an element from the top of the scroll content — robust to whether
  // the container is a positioned offsetParent.
  function topWithin(el: HTMLElement, c: HTMLElement): number {
    return el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
  }

  function scrollUserToTop(): void {
    const c = container.value;
    const userEl = lastUserEl();
    if (c && userEl) c.scrollTop = Math.max(0, topWithin(userEl, c) - TOP_PAD);
  }

  function lastIsStreaming(): boolean {
    const ms = messages.value;
    return !!ms[ms.length - 1]?.streaming;
  }

  const userCount = computed<number>(() =>
    messages.value.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0),
  );
  watch(userCount, (n) => {
    if (prevUserCount >= 0 && n > prevUserCount) {
      pinning = true;
      void nextTick(scrollUserToTop);
    }
    prevUserCount = n;
  });

  // Streamed growth (new blocks / token append): re-assert the pin so the
  // message stays at the top as the answer grows below it.
  const streamSignal = computed<string>(() => {
    const ms = messages.value;
    const last = ms[ms.length - 1];
    const lb = last?.blocks[last.blocks.length - 1];
    const tlen = lb && lb.kind === 'text' ? lb.text.length : 0;
    return `${ms.length}:${last?.blocks.length ?? 0}:${tlen}`;
  });
  watch(streamSignal, () => {
    if (!pinning) return;
    void nextTick(() => {
      scrollUserToTop();
      // Re-assert after paint: async blocks (charts) + browser scroll-anchoring
      // can nudge the position AFTER Vue's DOM update, which the nextTick pass
      // above misses.
      requestAnimationFrame(() => {
        if (pinning) scrollUserToTop();
      });
    });
  });

  // The operator taking over (wheel / touch) releases the pin — a real scroll
  // gesture that programmatic scrollTop writes never fire, so we don't fight it.
  function release(): void {
    pinning = false;
  }
  watch(
    container,
    (c, _old, onCleanup) => {
      if (!c) return;
      c.addEventListener('wheel', release, { passive: true });
      c.addEventListener('touchmove', release, { passive: true });
      onCleanup(() => {
        c.removeEventListener('wheel', release);
        c.removeEventListener('touchmove', release);
      });
      // Opening onto an existing conversation → pin its last question to the top
      // (same as after a send). A still-streaming answer keeps the pin held.
      if (messages.value.length > 0) {
        pinning = lastIsStreaming();
        void nextTick(scrollUserToTop);
      }
    },
    { immediate: true },
  );

  // Switching conversations → pin the newly-shown conversation's last question
  // to the top, same as opening one.
  if (conversationId) {
    watch(conversationId, () => {
      prevUserCount = userCount.value;
      pinning = lastIsStreaming();
      void nextTick(scrollUserToTop);
    });
  }
}
