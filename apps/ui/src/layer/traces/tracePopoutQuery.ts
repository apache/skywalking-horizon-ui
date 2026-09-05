export const TRACE_POPOUT_QUERY = 'traceId';
export const TRACE_POPOUT_AT = 'traceAt';
export const TRACE_POPOUT_TYPE = 'traceType';
export const TRACE_POPOUT_SEGMENT = 'traceSegmentId';
export const TRACE_POPOUT_SPAN_INDEX = 'traceSpanIndex';
export const TRACE_POPOUT_SPAN = 'traceSpanId';

export type TracePopoutQuery = Record<string, string | string[] | null | undefined>;
export type TraceFocus = { segmentId?: string | null; spanIndex?: number | null; spanId?: string | null };

export function withTraceFocus(query: TracePopoutQuery, focus?: TraceFocus): TracePopoutQuery {
  const next = { ...query };
  if (focus?.segmentId) next[TRACE_POPOUT_SEGMENT] = focus.segmentId; else delete next[TRACE_POPOUT_SEGMENT];
  if (focus?.spanIndex != null) next[TRACE_POPOUT_SPAN_INDEX] = String(focus.spanIndex); else delete next[TRACE_POPOUT_SPAN_INDEX];
  if (focus?.spanId) next[TRACE_POPOUT_SPAN] = focus.spanId; else delete next[TRACE_POPOUT_SPAN];
  return next;
}

export function clearTraceFocus(query: TracePopoutQuery): TracePopoutQuery {
  const next = { ...query };
  delete next[TRACE_POPOUT_SEGMENT];
  delete next[TRACE_POPOUT_SPAN_INDEX];
  delete next[TRACE_POPOUT_SPAN];
  return next;
}
