// lib/resetEngine.js
export const RESET_KEYS = {
  PINS: "tepiha_pins_v1",
  ARKA: "tepiha_arka_v1",
  VIS: "tepiha_role_visibility_v1",
  AUDIT: "tepiha_audit_log_v1",
  ROLE: "tepiha_role",
  SESSION: "tepiha_session_v1",
  CURRENT_USER: "CURRENT_USER_DATA",
  LS_USERS: "arka_workers_v1",
};

export const DEFAULT_VIS = {
  PUNTOR: { canSeeTotals: false, canAddExpense: true,  canSeePayments: true },
  TRANSPORT:{ canSeeTotals: false, canAddExpense: false, canSeePayments: false },
  ADMIN:  { canSeeTotals: true,  canAddExpense: true,  canSeePayments: true }
};

function nowIso(){ return new Date().toISOString(); }

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || ""); } catch { return fallback; }
}
function writeJSON(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

export function audit(event, detail = {}) {
  const log = readJSON(RESET_KEYS.AUDIT, []);
  log.unshift({ ts: nowIso(), event, detail });
  writeJSON(RESET_KEYS.AUDIT, log.slice(0, 300));
}

export function getResetPin() {
  const pins = readJSON(RESET_KEYS.PINS, null);
  return String(pins?.RESET_PIN || "").trim();
}

export function setResetPin(pin) {
  const pins = readJSON(RESET_KEYS.PINS, {});
  writeJSON(RESET_KEYS.PINS, { ...pins, RESET_PIN: String(pin || "").trim() });
  audit("RESET_PIN_SET", {});
}

export function applyReset(opts) {
  const { resetPins, resetArka, resetVisibility, fullReset } = opts || {};
  const changes = { resetPins: !!resetPins, resetArka: !!resetArka, resetVisibility: !!resetVisibility, fullReset: !!fullReset };

  if (fullReset) {
    // operative full reset (pa orders) — minimal
    localStorage.removeItem(RESET_KEYS.PINS);
    localStorage.removeItem(RESET_KEYS.ARKA);
    localStorage.removeItem(RESET_KEYS.VIS);
    localStorage.removeItem(RESET_KEYS.ROLE);
    localStorage.removeItem(RESET_KEYS.SESSION);
    localStorage.removeItem(RESET_KEYS.CURRENT_USER);
    audit("FULL_RESET_DONE", changes);
    return;
  }

  if (resetPins) {
    // fshin PIN-at (kërkon krijim prap)
    localStorage.removeItem(RESET_KEYS.PINS);
    audit("RESET_PINS_DONE", changes);
  }
  if (resetArka) {
    localStorage.removeItem(RESET_KEYS.ARKA);
    audit("RESET_ARKA_DONE", changes);
  }
  if (resetVisibility) {
    writeJSON(RESET_KEYS.VIS, DEFAULT_VIS);
    audit("RESET_VISIBILITY_DONE", changes);
  }
}