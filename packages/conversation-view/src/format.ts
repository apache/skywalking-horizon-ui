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
 * How moments and quantities are written. Each host keeps its own rule: the
 * Sessionizer's page fixes `en-US` with a 24-hour clock so two people looking
 * at one conversation read the same text; Horizon renders in the browser's
 * locale like the rest of its screens. Both hand the renderer one of these.
 */
export interface TimeFormatter {
  /** `12:34:56`, or a placeholder for an unobserved time (0). */
  time(ms: number): string;
  /** `12:34` for a tick on a whole minute. */
  timeShort(ms: number): string;
  /** `Sep 05`, empty for an unobserved time. */
  day(ms: number): string;
  /** `Sep 05 12:34:56` for a full stamp. */
  dateTime(ms: number): string;
  /** A count with grouping separators. */
  number(n: number): string;
  /** An elapsed span, or the word for an unavailable one. */
  duration(ms: number): string;
}

const UNOBSERVED = '--:--:--';

export function makeFormatter(locale: string, unavailable = 'unavailable'): TimeFormatter {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const short = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const day = new Intl.DateTimeFormat(locale, { month: 'short', day: '2-digit' });
  const num = new Intl.NumberFormat(locale);
  return {
    time: (ms) => (ms ? time.format(new Date(ms)) : UNOBSERVED),
    timeShort: (ms) => (ms ? short.format(new Date(ms)) : '--:--'),
    day: (ms) => (ms ? day.format(new Date(ms)) : ''),
    dateTime: (ms) => (ms ? `${day.format(new Date(ms))} ${time.format(new Date(ms))}` : UNOBSERVED),
    number: (n) => num.format(n ?? 0),
    duration: (ms) => {
      if (!Number.isFinite(ms)) return unavailable;
      if (ms < 1000) return `${Math.round(ms)} ms`;
      if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
      if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
      if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
      return `${(ms / 86_400_000).toFixed(ms < 864_000_000 ? 1 : 0)} d`;
    },
  };
}

/** The Sessionizer's own rule: one rendering for every reader. */
export const EN_US_FORMATTER: TimeFormatter = makeFormatter('en-US');
