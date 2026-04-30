const OFF_CONFIG = Object.freeze({
  enabled: false,
  level: 'off',
  scope: 'all',
  path: '',
  module: '',
  paths: [],
  modules: [],
  startedAt: 0,
  ttlMs: 0,
  expiresAt: 0,
  reason: 'removed_simple_incident_mode',
  search: '',
  captureBoot: false,
  captureSync: false,
  captureNetwork: false,
  captureInteractions: false,
  captureLongTasks: false,
});

export function readDiagKey() {
  return 'tepiha_diag_mode_disabled';
}

export function readDiagConfig() {
  return { ...OFF_CONFIG };
}

export function getDiagConfig() {
  return { ...OFF_CONFIG };
}

export function isDiagEnabled() {
  return false;
}

export function isDiagLevel() {
  return false;
}

export function isDiagSystemEnabled() {
  return false;
}

export function setDiagEnabled() {
  return false;
}

export function setDiagConfig() {
  return { ...OFF_CONFIG };
}

export function clearDiagConfig() {
  return { ...OFF_CONFIG };
}
