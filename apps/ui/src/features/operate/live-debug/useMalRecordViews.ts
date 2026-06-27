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
 * Reactive transform: a MAL `SessionResponse` (live or historical) →
 * the per-node / per-record view model `DebugMal.vue` renders. Stable
 * node sort, per-record sample-chain assembly with `before` linkage,
 * and the ≥2-output collapse into one diff-aware anchor row.
 *
 * No lifecycle to tear down — a `computed` derived from the supplied
 * session ref; it recomputes whenever the session does (each poll /
 * historical swap) and is GC'd with the owning component.
 */

import { computed, type ComputedRef, type Ref } from 'vue';
import type {
  MalOutputPayload,
  MalSamplesPayload,
  SessionResponse,
} from '@skywalking-horizon-ui/api-client';
import { isMalOutputPayload, isMalSamplesPayload } from './payload.js';
import {
  buildOutputGroup,
  type MalNodeView,
  type MalRecordView,
  type MalSampleRow,
} from './malGroups.js';

export function useMalRecordViews(
  session: Ref<SessionResponse | null>,
): ComputedRef<MalNodeView[]> {
  return computed<MalNodeView[]>(() => {
    const s = session.value;
    if (!s) return [];
    // OAP's session payload isn't guaranteed to list nodes in the same
    // order across polls. Without a stable sort the per-node cards
    // visibly reshuffle every refresh — hard to track which node moved.
    // Sort by nodeKey (nodeId / peer) so each card stays in place.
    const sortedNodes = s.nodes.slice().sort((a, b) => {
      const ak = a.nodeId ?? a.peer ?? '?';
      const bk = b.nodeId ?? b.peer ?? '?';
      return ak.localeCompare(bk);
    });
    return sortedNodes.map((n) => {
      const nKey = n.nodeId ?? n.peer ?? '?';
      const recordViews: MalRecordView[] = (n.records ?? []).map((rec, ri) => {
        const rows: MalSampleRow[] = [];
        let prevSamples: MalSamplesPayload | null = null;
        let prevOutput: MalOutputPayload | null = null;
        for (const sample of rec.samples ?? []) {
          const thisSamples = isMalSamplesPayload(sample.payload) ? sample.payload : null;
          const thisOutput = isMalOutputPayload(sample.payload) ? sample.payload : null;
          rows.push({
            rec,
            recordIdx: ri,
            nodeKey: nKey,
            sample,
            samples: thisSamples,
            output: thisOutput,
            before:
              rows.length === 0 ? null : { samples: prevSamples, output: prevOutput },
          });
          prevSamples = thisSamples;
          prevOutput = thisOutput;
        }
        // A MAL record's chain ends with one `output` sample per
        // materialised entity. When more than one fires they repeat the
        // same meter card with only the entity differing — collapse that
        // run into a single anchor carrying an `outputGroup` so the right
        // pane summarises them the same way input sample groups do.
        const outputRows = rows.filter((r) => r.output !== null);
        let displayRows = rows;
        if (outputRows.length > 1) {
          const chainRows = rows.filter((r) => r.output === null);
          const anchor: MalSampleRow = {
            ...outputRows[0]!,
            outputGroup: buildOutputGroup(
              `${nKey}#${ri}#outputs`,
              outputRows.map((r) => r.output!),
            ),
          };
          displayRows = [...chainRows, anchor];
        }
        return { rec, recordIdx: ri, rows, displayRows };
      });
      return { ...n, recordViews };
    });
  });
}
