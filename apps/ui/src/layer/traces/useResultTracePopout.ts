import { useTracePopout } from './useTracePopout';
import { useZipkinTracePopout } from './useZipkinTracePopout';

export type ResultTraceRef = {
  type: 'SKYWALKING_NATIVE' | 'OTLP';
  traceId: string;
  segmentId?: string | null;
  spanIndex?: number | null;
  spanId?: string | null;
};

/** Opens an evaluation result's trace using the renderer implied by traceRef.type. */
export function useResultTracePopout() {
  const { openTrace: openNativeTrace } = useTracePopout();
  const { openTrace: openOtlpTrace } = useZipkinTracePopout();

  function openResultTrace(ref: ResultTraceRef, atMs?: number): void {
    if (!ref.traceId) return;
    const focus = {
      segmentId: ref.segmentId ?? null,
      spanIndex: ref.spanIndex ?? null,
      spanId: ref.spanId ?? null,
    };
    if (ref.type === 'OTLP') {
      openOtlpTrace(ref.traceId, focus);
    } else {
      openNativeTrace(ref.traceId, atMs, ref.type, focus);
    }
  }

  return { openResultTrace };
}
