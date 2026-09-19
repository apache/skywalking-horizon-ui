<!--
  Licensed to the Apache Software Foundation (ASF) under one or more
  contributor license agreements.  See the NOTICE file distributed with
  this work for additional information regarding copyright ownership.
  The ASF licenses this file to You under the Apache License, Version 2.0
  (the "License"); you may not use this file except in compliance with
  the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->
<!--
  A local date and time, in HORIZON's locale.

  A drop-in for `<input type="datetime-local">`, which this replaces for one
  reason: that control is drawn by the browser in the BROWSER's UI language,
  which neither the page's `lang` nor Horizon's own locale picker can reach.
  Measured in Chromium with `lang="en"` on the page: a Chinese browser renders
  `yyyy/mm/dd` with 年 月 日 spinners, a German one `dd.mm.yyyy`. An operator
  reading an English console got a Chinese calendar, and no styling or markup
  changes that.

  So the field is ours. The text is a fixed `YYYY-MM-DD HH:mm` — the same
  unambiguous order the rest of the app prints timestamps in — and only the
  CALENDAR is localized, from `Intl` with Horizon's active locale, so month and
  weekday names follow the locale picker like every other string on screen.

  The model is the same `YYYY-MM-DDTHH:mm` string the native control emits, so
  a host swaps the tag and keeps its parsing, its `new Date(v)` and its tests.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';

const props = withDefaults(
  defineProps<{
    /** `YYYY-MM-DDTHH:mm`, as `<input type="datetime-local">` emits. Null is
     *  accepted because several hosts hold the pair as `string | null`, and
     *  this has to drop straight into them. */
    modelValue: string | null;
    /** `date` drops the time half and works in `YYYY-MM-DD`, for the ranges
     *  that are whole days. */
    mode?: 'datetime' | 'date';
    disabled?: boolean;
    /** Marks the field as unusable input without disabling it. */
    invalid?: boolean;
    ariaLabel?: string;
  }>(),
  { mode: 'datetime', disabled: false, invalid: false, ariaLabel: '' },
);
const emit = defineEmits<{ 'update:modelValue': [string] }>();

const { t, locale } = useI18n({ useScope: 'global' });

const root = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const open = ref(false);

/* ── the model, and the text that stands for it ───────────────────────── */

const pad = (n: number) => String(n).padStart(2, '0');
/** The model's shape. Anything else is text the operator is still typing. */
const MODEL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
/** What the field accepts back: the same fields, space or `T`, seconds
 *  tolerated and dropped — a pasted log timestamp should just work. The time
 *  half is optional, which is the whole of `date` mode and a lenient paste in
 *  the other. */
const TYPED = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?)?$/;

function partsOf(v: string): { y: number; m: number; d: number; hh: number; mm: number } | null {
  const m = MODEL.exec(v) ?? TYPED.exec(v);
  if (!m) return null;
  const [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
  const [hh, mm] = [m[4] === undefined ? 0 : +m[4], m[5] === undefined ? 0 : +m[5]];
  // A real calendar day: `2026-02-31` parses as fields and is not a date.
  const probe = new Date(y, mo - 1, d, hh, mm);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  if (hh > 23 || mm > 59) return null;
  return { y, m: mo, d, hh, mm };
}
const model = (y: number, m: number, d: number, hh: number, mm: number) =>
  props.mode === 'date' ? `${y}-${pad(m)}-${pad(d)}` : `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}`;
/** What the text field shows for a model that parses. */
const asText = (p: { y: number; m: number; d: number; hh: number; mm: number }) =>
  props.mode === 'date'
    ? `${p.y}-${pad(p.m)}-${pad(p.d)}`
    : `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}`;

/** The typed text, held apart from the model. While the field has FOCUS the
 *  model never writes back into it: `2026-09-1` parses as the 1st, and
 *  normalising that mid-word moved the cursor and corrupted the rest of what
 *  was being typed. Blur settles it. */
const text = ref('');
const focused = ref(false);
/** What a keystroke has to reach before it commits — the whole shape, so a day
 *  typed one digit at a time does not commit a date nobody asked for. */
const COMPLETE = computed(() =>
  props.mode === 'date'
    ? /^\d{4}-\d{1,2}-\d{1,2}$/
    : /^\d{4}-\d{1,2}-\d{1,2}[T ]\d{1,2}:\d{2}(?::\d{2})?$/,
);
const selected = computed(() => partsOf(props.modelValue ?? ''));
watch(
  () => props.modelValue,
  (v) => {
    if (focused.value) return;
    const p = partsOf(v ?? '');
    text.value = p ? asText(p) : (v ?? '');
  },
  { immediate: true },
);

function onInput(e: Event): void {
  text.value = (e.target as HTMLInputElement).value;
  const typed = text.value.trim();
  if (!typed) {
    emit('update:modelValue', '');
    return;
  }
  if (!COMPLETE.value.test(typed)) return;
  const p = partsOf(typed);
  if (p) emit('update:modelValue', model(p.y, p.m, p.d, p.hh, p.mm));
}
/** On blur the text goes back to whatever the model says, so an unparseable
 *  edit does not sit there looking like a value. A COMPLETE one is committed
 *  first — leaving the field is a commit, not a cancel. */
function onBlur(): void {
  focused.value = false;
  const typed = text.value.trim();
  const p = COMPLETE.value.test(typed) ? partsOf(typed) : null;
  if (p) emit('update:modelValue', model(p.y, p.m, p.d, p.hh, p.mm));
  const settled = p ?? selected.value;
  text.value = settled ? asText(settled) : '';
}
const textInvalid = computed(() => text.value.trim() !== '' && partsOf(text.value) === null);

/* ── the calendar, in Horizon's locale ────────────────────────────────── */

/** The month being shown, which is not the selection: paging to March does
 *  not pick a day in March. */
const view = ref<{ y: number; m: number }>({ y: 2000, m: 1 });
function resetView(): void {
  const p = selected.value;
  const now = new Date();
  view.value = p ? { y: p.y, m: p.m } : { y: now.getFullYear(), m: now.getMonth() + 1 };
}

const intlLocale = computed(() => locale.value);
const monthLabel = computed(() =>
  new Intl.DateTimeFormat(intlLocale.value, { year: 'numeric', month: 'long' })
    .format(new Date(view.value.y, view.value.m - 1, 1)),
);
/**
 * Which weekday a calendar starts on, 1 = Monday … 7 = Sunday.
 *
 * Stated per locale rather than read from `Intl.Locale.weekInfo`, which the
 * engines we ship to mostly do NOT have — Chromium returns undefined, and the
 * fallback then started every locale on Monday, which is wrong for four of the
 * eight. The values are CLDR's: Sunday for English, Japanese, Korean and
 * Portuguese, Monday for German, Spanish, French and Simplified Chinese.
 */
const WEEK_STARTS_ON: Readonly<Record<string, number>> = {
  en: 7, ja: 7, ko: 7, pt: 7,
  de: 1, es: 1, fr: 1, 'zh-CN': 1,
};
const firstDay = computed(() => WEEK_STARTS_ON[intlLocale.value] ?? 1);
const weekdays = computed(() => {
  const fmt = new Intl.DateTimeFormat(intlLocale.value, { weekday: 'narrow' });
  // 2024-01-01 was a Monday, so it anchors the rotation.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + ((firstDay.value - 1 + i) % 7))));
});

interface Cell { key: string; day: number; y: number; m: number; outside: boolean }
const cells = computed<Cell[]>(() => {
  const { y, m } = view.value;
  const first = new Date(y, m - 1, 1);
  // How many leading cells belong to the previous month, given where the
  // locale's week starts.
  const lead = (first.getDay() - (firstDay.value % 7) + 7) % 7;
  const start = new Date(y, m - 1, 1 - lead);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return {
      key: `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,
      day: d.getDate(),
      y: d.getFullYear(),
      m: d.getMonth() + 1,
      outside: d.getMonth() + 1 !== m,
    };
  });
});

const today = computed(() => {
  const n = new Date();
  return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() };
});
const isSelected = (c: Cell) => {
  const p = selected.value;
  return !!p && p.y === c.y && p.m === c.m && p.d === c.day;
};
const isToday = (c: Cell) => today.value.y === c.y && today.value.m === c.m && today.value.d === c.day;

function stepMonth(by: number): void {
  const d = new Date(view.value.y, view.value.m - 1 + by, 1);
  view.value = { y: d.getFullYear(), m: d.getMonth() + 1 };
}
function pickDay(c: Cell): void {
  const p = selected.value;
  emit('update:modelValue', model(c.y, c.m, c.day, p?.hh ?? 0, p?.mm ?? 0));
  if (c.outside) view.value = { y: c.y, m: c.m };
}
/**
 * The time half — a PLAIN text field, for the same reason the date half is
 * ours: `<input type="time">` is drawn by the browser too, so on a Chinese
 * browser it reads 时 / 分 and on a US one it grows an AM/PM spinner. 24-hour
 * `HH:mm` is what the rest of the app prints.
 *
 * A day with no time is midnight, which is what a bare date means anywhere.
 */
const timeText = ref('');
watch(selected, (p) => { timeText.value = p ? `${pad(p.hh)}:${pad(p.mm)}` : ''; }, { immediate: true });
const TIME = /^(\d{1,2}):(\d{2})$/;
function setTime(e: Event): void {
  timeText.value = (e.target as HTMLInputElement).value;
  const m = TIME.exec(timeText.value.trim());
  if (!m) return;
  const [hh, mm] = [+m[1]!, +m[2]!];
  if (hh > 23 || mm > 59) return;
  const p = selected.value ?? { ...today.value, hh: 0, mm: 0 };
  emit('update:modelValue', model(p.y, p.m, p.d, hh, mm));
}
function onTimeBlur(): void {
  const p = selected.value;
  timeText.value = p ? `${pad(p.hh)}:${pad(p.mm)}` : '';
}
function pickNow(): void {
  const n = new Date();
  emit('update:modelValue', model(n.getFullYear(), n.getMonth() + 1, n.getDate(), n.getHours(), n.getMinutes()));
  resetView();
}

/* ── the panel, which must not be clipped by the card it sits in ──────── */

const panelStyle = ref<Record<string, string>>({});
const GAP = 4;
const EDGE = 8;
const PANEL_W = 248;
function place(): void {
  const el = root.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - GAP - EDGE;
  const above = r.top - GAP - EDGE;
  const up = below < 290 && above > below;
  panelStyle.value = {
    left: `${Math.max(EDGE, Math.min(r.left, window.innerWidth - PANEL_W - EDGE))}px`,
    ...(up ? { bottom: `${window.innerHeight - r.top + GAP}px` } : { top: `${r.bottom + GAP}px` }),
  };
}
function track(on: boolean): void {
  const fn = on ? window.addEventListener : window.removeEventListener;
  fn('scroll', place, true);
  fn('resize', place);
}
function toggle(): void {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) resetView();
}
function onDocPointer(e: Event): void {
  const target = e.target as Node;
  if (root.value?.contains(target)) return;
  if (panelEl.value?.contains(target)) return;
  open.value = false;
}
function onDocKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value) {
    open.value = false;
    inputEl.value?.focus();
  }
}
const panelEl = ref<HTMLElement | null>(null);
watch(open, (v) => {
  track(v);
  if (v) {
    void nextTick(place);
    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onDocKey);
  } else {
    document.removeEventListener('pointerdown', onDocPointer);
    document.removeEventListener('keydown', onDocKey);
  }
});
onBeforeUnmount(() => {
  track(false);
  document.removeEventListener('pointerdown', onDocPointer);
  document.removeEventListener('keydown', onDocKey);
});
</script>

<template>
  <div ref="root" class="dtf" :class="{ invalid: invalid || textInvalid, disabled }">
    <input
      ref="inputEl"
      class="dtf-input mono"
      type="text"
      inputmode="numeric"
      :value="text"
      :disabled="disabled"
      :aria-label="ariaLabel || t('Date and time')"
      :placeholder="mode === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm'"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
      @focus="focused = true"
      @blur="onBlur"
    />
    <button
      type="button"
      class="dtf-open"
      :disabled="disabled"
      :aria-label="t('Open the calendar')"
      :aria-expanded="open"
      @click="toggle"
    >
      <Icon name="clock" :size="12" />
    </button>

    <Teleport to="body">
      <!-- The panel lives in `body`, so a host that closes itself on a click
           outside its own element — the topbar's time menu does — counts every
           click in here as outside and discards the draft. Clicks stop at the
           panel; the field's own outside-close reads `pointerdown` instead. -->
      <div
        v-if="open"
        ref="panelEl"
        class="dtf-panel"
        :style="panelStyle"
        @click.stop
        @mousedown.stop
      >
        <header class="dtf-head">
          <button type="button" class="dtf-nav" :aria-label="t('Previous month')" @click="stepMonth(-1)">‹</button>
          <span class="dtf-month">{{ monthLabel }}</span>
          <button type="button" class="dtf-nav" :aria-label="t('Next month')" @click="stepMonth(1)">›</button>
        </header>
        <div class="dtf-week">
          <span v-for="(w, i) in weekdays" :key="i">{{ w }}</span>
        </div>
        <div class="dtf-grid">
          <button
            v-for="c in cells"
            :key="c.key"
            type="button"
            class="dtf-day"
            :class="{ out: c.outside, on: isSelected(c), today: isToday(c) }"
            @click="pickDay(c)"
          >{{ c.day }}</button>
        </div>
        <footer v-if="mode !== 'date'" class="dtf-foot">
          <input
            class="dtf-time mono"
            type="text"
            inputmode="numeric"
            maxlength="5"
            placeholder="HH:mm"
            :value="timeText"
            :aria-label="t('Time')"
            @input="setTime"
            @blur="onTimeBlur"
          />
          <button type="button" class="sw-btn small ghost" @click="pickNow">{{ t('Now') }}</button>
        </footer>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.dtf {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 28px;
  padding: 0 4px 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  min-width: 0;
}
.dtf:focus-within { border-color: var(--sw-accent); }
.dtf.invalid { border-color: var(--sw-warn); }
.dtf.disabled { opacity: 0.5; }
.dtf-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 12px;
  outline: none;
  padding: 0;
}
.dtf-input::placeholder { color: var(--sw-fg-3); }
.dtf-open {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--sw-fg-2);
  cursor: pointer;
}
.dtf-open:hover { background: var(--sw-bg-3); color: var(--sw-accent); }

/* Fixed, in `body`: every host puts this field inside a card that clips. */
.dtf-panel {
  position: fixed;
  z-index: 1200;
  width: 248px;
  padding: 8px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
}
.dtf-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.dtf-month { flex: 1; text-align: center; font-size: 11.5px; color: var(--sw-fg-0); }
.dtf-nav {
  width: 20px; height: 20px; border: 1px solid var(--sw-line-2); border-radius: 3px;
  background: var(--sw-bg-2); color: var(--sw-fg-2); font: inherit; cursor: pointer; line-height: 1;
}
.dtf-nav:hover { border-color: var(--sw-accent); color: var(--sw-accent); }
.dtf-week, .dtf-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px; }
.dtf-week span { text-align: center; font-size: 9.5px; color: var(--sw-fg-3); padding-bottom: 2px; }
.dtf-day {
  height: 24px; border: none; border-radius: 3px; background: transparent;
  color: var(--sw-fg-1); font: inherit; font-size: 11px; cursor: pointer;
}
.dtf-day:hover { background: var(--sw-bg-3); }
.dtf-day.out { color: var(--sw-fg-3); }
.dtf-day.today { box-shadow: inset 0 0 0 1px var(--sw-line-3); }
.dtf-day.on { background: var(--sw-accent); color: var(--sw-bg-0); }
.dtf-foot { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
.dtf-time {
  flex: 1;
  height: 24px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.mono { font-family: var(--sw-mono); }
</style>
