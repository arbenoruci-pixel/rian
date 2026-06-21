const EMPTY_STATE = Object.freeze({
  now: null,
  currentPath: '',
  online: true,
  diagEnabled: false,
  lastEvent: null,
  counters: {
    enqueue: 0,
    syncRuns: 0,
    successOps: 0,
    failedOps: 0,
    networkStops: 0,
    permanentStops: 0,
    lockedRuns: 0,
  },
  events: [],
});

function cloneEmpty() {
  return {
    ...EMPTY_STATE,
    counters: { ...EMPTY_STATE.counters },
    events: [],
  };
}

export function readSyncDebug() {
  return cloneEmpty();
}

export function resetSyncDebug() {
  return true;
}

export function bumpSyncCounter() {
  return cloneEmpty();
}

export function syncDebugLog() {
  return cloneEmpty();
}
