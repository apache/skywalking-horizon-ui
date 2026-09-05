import { describe, expect, it } from 'vitest';
import { clearTraceFocus, withTraceFocus } from './tracePopoutQuery';

describe('trace popout query state', () => {
  it('adds focus fields without changing unrelated preview source', () => {
    const query = withTraceFocus({ source: 'bundled', traceId: 'old' }, {
      segmentId: 'segment-1', spanIndex: 3, spanId: 'span-7',
    });
    expect(query).toMatchObject({
      source: 'bundled', traceId: 'old', traceSegmentId: 'segment-1', traceSpanIndex: '3', traceSpanId: 'span-7',
    });
  });

  it('replaces stale focus fields when the next result has no focus', () => {
    const query = withTraceFocus({ source: 'local', traceSpanId: 'stale', traceSpanIndex: '2' });
    expect(query).toEqual({ source: 'local' });
  });

  it('clears focus fields while retaining trace type and source', () => {
    const query = clearTraceFocus({ source: 'remote', traceType: 'OTLP', traceId: 'abc', traceSpanId: 's' });
    expect(query).toEqual({ source: 'remote', traceType: 'OTLP', traceId: 'abc' });
  });
});
