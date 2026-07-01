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
 * Swimlane (Gantt) layout for the events timeline — a Layer → Service →
 * Instance tree. Layers are the top group; each service under a layer is
 * colored and (when it reports real instances) foldable into one row per
 * instance. A service-scoped service — every event with an empty instance —
 * collapses to a SINGLE row instead of a redundant header plus a same-named
 * row. Bars are positioned on a shared time axis; an event with no end time is
 * an instantaneous marker rather than a bar; overlapping events on one instance
 * stack into sub-lanes.
 */

import { ENTITY_PALETTE } from '@/utils/metricColor';
import type { EventRow } from '@/api/client';

/** Event timestamp, mirroring OAP: `endTime` if finished, else `startTime`. */
export function eventTs(e: EventRow): number {
  return e.endTime && e.endTime > 0 ? e.endTime : e.startTime;
}

export interface GanttBar {
  event: EventRow;
  /** Bar start (ms). Falls back to `eventTs` when the reporter sent no start. */
  start: number;
  /** Bar end (ms), or `null` for an instantaneous event (rendered as a marker). */
  end: number | null;
  /** Sub-lane index within the instance row (for overlapping events). */
  subLane: number;
}

export interface GanttInstanceRow {
  /** Instance name, or '' for a service-scoped event with no instance. */
  instance: string;
  bars: GanttBar[];
  /** Number of stacked sub-lanes this row needs (row height driver). */
  subLanes: number;
}

export interface GanttServiceGroup {
  key: string;
  service: string;
  color: string;
  rows: GanttInstanceRow[];
  eventCount: number;
  /** True when the only row is the '' (no-instance) row — render inline. */
  serviceScoped: boolean;
}

export interface GanttLayerGroup {
  key: string;
  layer: string;
  services: GanttServiceGroup[];
  eventCount: number;
}

function barStart(e: EventRow): number {
  return e.startTime && e.startTime > 0 ? e.startTime : eventTs(e);
}
function barEnd(e: EventRow): number | null {
  return e.endTime && e.endTime > barStart(e) ? e.endTime : null;
}

/** Pack an instance's events into sub-lanes so overlapping intervals never
 *  share a lane. An instantaneous event occupies a zero-width slot at its
 *  start, so only events at the same instant collide. */
function packSubLanes(events: EventRow[]): { bars: GanttBar[]; subLanes: number } {
  const sorted = [...events].sort((a, b) => barStart(a) - barStart(b));
  const laneEnds: number[] = []; // last occupied end (ms) per sub-lane
  const bars: GanttBar[] = [];
  for (const e of sorted) {
    const s = barStart(e);
    const en = barEnd(e);
    const occupiedUntil = en ?? s;
    let lane = laneEnds.findIndex((end) => end < s);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(occupiedUntil);
    } else {
      laneEnds[lane] = occupiedUntil;
    }
    bars.push({ event: e, start: s, end: en, subLane: lane });
  }
  return { bars, subLanes: Math.max(1, laneEnds.length) };
}

// Layer / service map keys use a control-char delimiter that can't appear in a
// layer key or service name (written as an escape so the source stays plain).
const SEP = '\u0000';

/**
 * Build the Layer → Service → Instance tree. Layers sort by name; services sort
 * by name within a layer; instances sort by name within a service. Colors are
 * assigned per service across the whole view so neighbouring services stay
 * distinct. Feed this the events for the window; a scoped popout passes one
 * service's events.
 */
export function buildGantt(events: readonly EventRow[]): GanttLayerGroup[] {
  const tree = new Map<string, Map<string, Map<string, EventRow[]>>>();
  for (const e of events) {
    let byService = tree.get(e.layer);
    if (!byService) {
      byService = new Map();
      tree.set(e.layer, byService);
    }
    let byInstance = byService.get(e.source.service);
    if (!byInstance) {
      byInstance = new Map();
      byService.set(e.source.service, byInstance);
    }
    const ik = e.source.serviceInstance ?? '';
    const arr = byInstance.get(ik);
    if (arr) arr.push(e);
    else byInstance.set(ik, [e]);
  }

  const layers: GanttLayerGroup[] = [];
  for (const [layer, byService] of tree) {
    const services: GanttServiceGroup[] = [];
    let layerCount = 0;
    for (const [service, byInstance] of byService) {
      const rows: GanttInstanceRow[] = [];
      let svcCount = 0;
      for (const [instance, evs] of byInstance) {
        const { bars, subLanes } = packSubLanes(evs);
        svcCount += evs.length;
        rows.push({ instance, bars, subLanes });
      }
      rows.sort((a, b) => a.instance.localeCompare(b.instance));
      layerCount += svcCount;
      services.push({
        key: `${layer}${SEP}${service}`,
        service,
        color: ENTITY_PALETTE[0]!, // reassigned per-service below
        rows,
        eventCount: svcCount,
        serviceScoped: rows.length === 1 && rows[0]!.instance === '',
      });
    }
    services.sort((a, b) => a.service.localeCompare(b.service));
    layers.push({ key: layer, layer, services, eventCount: layerCount });
  }
  layers.sort((a, b) => a.layer.localeCompare(b.layer));

  // Distinct color per service across the whole view (palette is small, so
  // assign by position rather than hashing to avoid neighbour collisions).
  let ci = 0;
  for (const l of layers) for (const s of l.services) s.color = ENTITY_PALETTE[ci++ % ENTITY_PALETTE.length]!;
  return layers;
}
