// Read/housekeeping-only compatibility facade.
// Allocation and lifecycle mutations are available only through pranimiCodeAllocator.
export {
  normalizeCode,
  computeM2FromRows,
  ensureBasePool,
  ensureBaseCodeEpochFresh,
  getBaseCodeReservationDiagnostics,
  resetBaseCodeReservationCompatibilityCache,
} from './baseCodes.js';
