import { bootMarkReady, bootSnapshot } from '@/lib/bootLog';

export function logDebugEvent() {
  return false;
}

export function initCrashRadar() {
  return false;
}

export function trackRender() {
  return 0;
}

export function getRadarStats() {
  return { renders: {}, events: { fallbackCount: 0 } };
}

export function clearRadarStats() {
  return undefined;
}

export function init() {
  return false;
}

export function markFirstUiReady(meta = {}) {
  try {
    return bootMarkReady(meta || {});
  } catch {
    return false;
  }
}

export function setOverlayShown() {
  return true;
}

export function clearRadar() {
  return undefined;
}

export function getRadarSnapshot() {
  return {
    boot: bootSnapshot(),
    fallbackLogs: [],
    liveBootEvents: [],
    renders: {},
    meta: { diagDisabled: true },
  };
}

export function exportDebugText() {
  try {
    return JSON.stringify(getRadarSnapshot(), null, 2);
  } catch {
    return '{}';
  }
}

const sensor = {
  init,
  initCrashRadar,
  trackRender,
  getRadarStats,
  clearRadarStats,
  clearRadar,
  getRadarSnapshot,
  logDebugEvent,
  markFirstUiReady,
  setOverlayShown,
  exportDebugText,
};

export default sensor;
