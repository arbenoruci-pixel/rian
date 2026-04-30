'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

function scheduleIdle(cb, delay = 0) {
  if (typeof window === 'undefined') return 0;
  const safeDelay = Math.max(0, Number(delay) || 0);
  return window.setTimeout(() => {
    try {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => {
          try { cb(); } catch {}
        }, { timeout: 180 });
      } else {
        cb();
      }
    } catch {}
  }, safeDelay);
}

export function useRenderBatches(items, options = {}) {
  const initial = Math.max(1, Number(options?.initial) || 12);
  const step = Math.max(1, Number(options?.step) || initial);
  const pulseMs = Math.max(40, Number(options?.pulseMs) || 90);
  const limit = Math.max(1, Number(options?.limit) || Number.POSITIVE_INFINITY);

  const source = useMemo(() => {
    const list = Array.isArray(items) ? items : [];
    return Number.isFinite(limit) ? list.slice(0, limit) : list;
  }, [items, limit]);

  const [renderCount, setRenderCount] = useState(() => Math.min(source.length, initial));
  const timerRef = useRef(0);
  const sourceLenRef = useRef(source.length);

  useEffect(() => {
    sourceLenRef.current = source.length;
    setRenderCount(Math.min(source.length, initial));
  }, [source, initial]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = 0;
    }
    if (renderCount >= source.length) return undefined;

    const pump = () => {
      setRenderCount((prev) => {
        const total = sourceLenRef.current;
        if (prev >= total) return prev;
        return Math.min(total, prev + step);
      });
    };

    timerRef.current = scheduleIdle(pump, pulseMs);

    return () => {
      if (timerRef.current) {
        try { window.clearTimeout(timerRef.current); } catch {}
        timerRef.current = 0;
      }
    };
  }, [renderCount, source.length, step, pulseMs]);

  const visibleItems = useMemo(() => source.slice(0, renderCount), [source, renderCount]);
  const remainingCount = Math.max(0, source.length - visibleItems.length);

  return {
    visibleItems,
    totalCount: source.length,
    renderedCount: visibleItems.length,
    remainingCount,
    renderMore: () => {
      setRenderCount((prev) => Math.min(sourceLenRef.current, prev + step));
    },
    renderAll: () => {
      setRenderCount(sourceLenRef.current);
    },
  };
}
