// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements.  See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type { ProfileSpan, ProfileTimeRange } from '@/api/client';

// Resolve the analyze time-ranges for a profiled span. `include` analyzes the
// whole span window; `exclude` carves the children out so only the span's own
// (self) time is analyzed — overlapping carved ranges are merged and zero-width
// ranges dropped.
export function profileTimeRanges(
  span: ProfileSpan,
  mode: 'include' | 'exclude',
): ProfileTimeRange[] {
  if (mode === 'include') {
    return [{ start: span.startTime, end: span.endTime }];
  }
  const children = span.children ?? [];
  if (!children.length) return [{ start: span.startTime, end: span.endTime }];
  let ranges: ProfileTimeRange[] = [];
  for (const c of children) {
    ranges.push({ start: span.startTime, end: c.startTime });
    ranges.push({ start: c.endTime, end: span.endTime });
  }
  ranges = ranges.reduce<ProfileTimeRange[]>((acc, cur) => {
    let merged = false;
    for (const r of acc) {
      if (cur.start <= r.end && r.start <= cur.start) {
        r.start = Math.max(r.start, cur.start);
        r.end = Math.min(r.end, cur.end);
        merged = true;
      }
    }
    if (!merged) acc.push(cur);
    return acc;
  }, []);
  return ranges.filter((r) => r.start !== r.end);
}
