// FILE: lib/tepihaCode.js
// Centralized helpers for code handling + shared utilities used by PRANIMI and other stages.
// This file is the stable entry-point ("CODE ENGINE").
// If you need to change how codes are reserved/finalized, change it here — NOT in PRANIMI.

export {
  normalizeCode,
  codeToNumber,
  computeM2FromRows,
  reserveSharedCode,
  markCodeUsed,
  releaseLocksForCode,
} from '@/lib/codeLease';
