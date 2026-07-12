const OUTBOX_SNAPSHOT_KEY = 'tepiha_sync_snapshot_v1';
const LAST_SUCCESS_MARKER_KEY = 'tepiha_offline_queued_success_last_v1';
const PROCESSED_ATTR = 'data-tepiha-offline-queued-success';
const TOAST_ID = 'tepiha-offline-queued-success-toast';

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function firstMatch(text, patterns = []) {
  const raw = String(text || '');
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const value = String(match?.[1] || '').trim();
    if (value) return value;
  }
  return '';
}

export function extractOfflineQueuedWarningIdentity(text = '') {
  const raw = String(text || '');
  return {
    local_oid: firstMatch(raw, [
      /Local\s*OID\s*:\s*([A-Za-z0-9._:-]+)/i,
      /local_oid\s*[:=]\s*([A-Za-z0-9._:-]+)/i,
    ]),
    save_attempt_id: firstMatch(raw, [
      /Save\s*Attempt\s*ID\s*:\s*([A-Za-z0-9._:-]+)/i,
      /save_attempt_id\s*[:=]\s*([A-Za-z0-9._:-]+)/i,
    ]),
    code: firstMatch(raw, [
      /(?:^|\n)\s*Kodi\s*:\s*(T?\d+)/im,
      /(?:^|\n)\s*Code\s*:\s*(T?\d+)/im,
    ]).toUpperCase(),
  };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readQueuedIdentity(item = {}) {
  const payload = asObject(item?.payload || item?.data);
  const data = asObject(payload?.data);
  const lifecycle = asObject(data?.pranimi_code_lifecycle);
  const safety = asObject(data?.sync_safety);
  const table = String(payload?.table || item?.table || payload?._table || '').trim();
  const type = String(item?.type || item?.kind || item?.op || '').trim().toLowerCase();
  const status = String(item?.status || 'pending').trim().toLowerCase();
  const opId = String(item?.op_id || item?.id || data?.outbox_op_id || lifecycle?.outbox_op_id || safety?.outbox_op_id || '').trim();
  const localOid = String(
    payload?.local_oid ||
    data?.local_oid ||
    lifecycle?.local_oid ||
    safety?.local_oid ||
    item?.uniqueValue ||
    ''
  ).trim();
  const saveAttemptId = String(
    data?.save_attempt_id ||
    lifecycle?.save_attempt_id ||
    safety?.save_attempt_id ||
    ''
  ).trim();
  const rawCode = payload?.code ?? data?.code ?? data?.client_code ?? data?.client?.code ?? item?.code ?? '';
  const code = String(rawCode || '').trim().toUpperCase();
  return { table, type, status, op_id: opId, local_oid: localOid, save_attempt_id: saveAttemptId, code, payload };
}

function isPendingLikeStatus(status = '') {
  return ['pending', 'queued', 'retry', 'retrying', 'processing', 'syncing'].includes(String(status || '').trim().toLowerCase());
}

function isBaseInsert(identity = {}) {
  if (String(identity?.table || '') !== 'orders') return false;
  const type = String(identity?.type || '').toLowerCase();
  return type === 'insert_order' || type === 'base_order' || type.includes('insert_order');
}

export function findMatchingQueuedBaseInsert(snapshot = [], warningIdentity = {}) {
  const localOid = String(warningIdentity?.local_oid || '').trim();
  const saveAttemptId = String(warningIdentity?.save_attempt_id || '').trim();
  const code = String(warningIdentity?.code || '').trim().toUpperCase();
  if (!localOid) return null;

  for (const item of Array.isArray(snapshot) ? snapshot : []) {
    const queued = readQueuedIdentity(item);
    if (!isBaseInsert(queued) || !isPendingLikeStatus(queued.status) || !queued.op_id) continue;
    if (queued.local_oid !== localOid) continue;
    if (saveAttemptId && queued.save_attempt_id !== saveAttemptId) continue;
    if (code && queued.code !== code) continue;
    return queued;
  }
  return null;
}

export function inspectOfflineQueuedSuccess({ modalText = '', snapshot = [] } = {}) {
  const normalized = normalizeText(modalText);
  const expectedNormalOfflineSave = (
    normalized.includes('LOCAL / NOT SYNCED') &&
    normalized.includes('RUAJTUR LOKALISHT') &&
    normalized.includes('OFFLINE_VERIFIED_ASSIGNMENT_PROOF') &&
    normalized.includes('NUK KA HYRE')
  );
  const trueError = (
    normalized.includes('DB VERIFY MISMATCH') ||
    normalized.includes('KLIENTI NUK U VERIFIKUA') ||
    normalized.includes('CODE ACK FAILED') ||
    normalized.includes('PROBLEM ME KODIN') ||
    normalized.includes('ARKA PROBLEM')
  );
  if (!expectedNormalOfflineSave || trueError) return { ok: false, reason: trueError ? 'REAL_ERROR_MODAL' : 'NOT_NORMAL_OFFLINE_QUEUE_MODAL' };

  const identity = extractOfflineQueuedWarningIdentity(modalText);
  if (!identity.local_oid) return { ok: false, reason: 'LOCAL_OID_MISSING', identity };
  if (!identity.save_attempt_id) return { ok: false, reason: 'SAVE_ATTEMPT_ID_MISSING', identity };
  if (!identity.code) return { ok: false, reason: 'CODE_MISSING', identity };
  const queued = findMatchingQueuedBaseInsert(snapshot, identity);
  if (!queued) return { ok: false, reason: 'MATCHING_OUTBOX_INSERT_MISSING', identity };
  return { ok: true, reason: 'OFFLINE_ORDER_SAFELY_QUEUED', identity, queued };
}

function readSnapshotSync() {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage?.getItem?.(OUTBOX_SNAPSHOT_KEY) || '[]';
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function showSuccessToast(detail = {}) {
  if (!isBrowser()) return;
  try {
    document.getElementById(TOAST_ID)?.remove?.();
    const node = document.createElement('div');
    node.id = TOAST_ID;
    node.setAttribute('role', 'status');
    node.style.cssText = [
      'position:fixed',
      'left:16px',
      'right:16px',
      'top:calc(14px + env(safe-area-inset-top,0px))',
      'z-index:2147483647',
      'padding:14px 16px',
      'border-radius:16px',
      'background:rgba(5,46,22,.97)',
      'border:1px solid rgba(74,222,128,.65)',
      'color:#dcfce7',
      'box-shadow:0 18px 50px rgba(0,0,0,.48)',
      'font:900 14px/1.35 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'text-align:center',
    ].join(';');
    node.textContent = `POROSIA ${detail?.code ? `#${detail.code} ` : ''}U RUAJT OFFLINE • DO SINKRONIZOHET AUTOMATIKISHT`;
    (document.body || document.documentElement).appendChild(node);
    window.setTimeout(() => {
      try { node.remove(); } catch {}
    }, 4200);
  } catch {}
}

function persistSuccessMarker(result = {}) {
  if (!isBrowser()) return;
  try {
    const marker = {
      at: new Date().toISOString(),
      ts: Date.now(),
      local_oid: result?.identity?.local_oid || '',
      save_attempt_id: result?.identity?.save_attempt_id || '',
      code: result?.identity?.code || result?.queued?.code || '',
      outbox_op_id: result?.queued?.op_id || '',
      status: 'LOCAL_QUEUED',
      source: 'offlineQueuedOrderUiGuard-v1',
    };
    window.localStorage?.setItem?.(LAST_SUCCESS_MARKER_KEY, JSON.stringify(marker));
    window.dispatchEvent(new CustomEvent('tepiha:offline-order-queued-success', { detail: marker }));
    window.dispatchEvent(new Event('tepiha:outbox-changed'));
  } catch {}
}

function rewriteAsQueuedSuccess(modal, result = {}) {
  try {
    const title = modal.querySelector('.apple-sheet-title');
    if (title) title.textContent = 'POROSIA U RUAJT OFFLINE';
    const subtitle = modal.querySelector('.apple-sheet-sub');
    if (subtitle) subtitle.textContent = 'NË PRITJE PËR SINKRONIZIM';

    const infoCards = modal.querySelectorAll('.client-empty-state');
    if (infoCards[0]) {
      const heading = infoCards[0].querySelector('div');
      if (heading) heading.textContent = 'RUAJTUR NË RADHË — DO SINKRONIZOHET KUR TË KETË INTERNET';
      const help = infoCards[0].querySelectorAll('div')[2] || infoCards[0].querySelectorAll('div')[1];
      if (help) help.textContent = 'Porosia dhe kodi offline janë ruajtur. Mund të vazhdosh normalisht; sinkronizimi bëhet automatikisht kur kthehet rrjeti.';
    }

    const buttons = Array.from(modal.querySelectorAll('button'));
    for (const button of buttons) {
      const label = normalizeText(button.textContent || '');
      if (['LAJMERO ADMININ', 'COPY PROBLEM', 'EXPORT DEBUG', 'RETRY'].includes(label)) {
        button.style.display = 'none';
        button.setAttribute('aria-hidden', 'true');
      }
      if (label === 'VAZHDO') {
        button.textContent = 'VAZHDO TE PASTRIMI';
        button.setAttribute('data-offline-queued-success-continue', '1');
      }
    }
    modal.style.borderColor = 'rgba(74,222,128,.72)';
    modal.style.boxShadow = '0 24px 80px rgba(5,150,105,.32)';
  } catch {}
}

function findNormalOfflineModal() {
  if (!isBrowser()) return null;
  const candidates = Array.from(document.querySelectorAll('.wiz-backdrop'));
  return candidates.find((node) => {
    if (node.getAttribute(PROCESSED_ATTR)) return false;
    const text = normalizeText(node.textContent || '');
    return text.includes('LOCAL / NOT SYNCED') && text.includes('OFFLINE_VERIFIED_ASSIGNMENT_PROOF') && text.includes('RUAJTUR LOKALISHT');
  }) || null;
}

function processModal(modal) {
  if (!modal || modal.getAttribute(PROCESSED_ATTR)) return false;
  const result = inspectOfflineQueuedSuccess({ modalText: modal.textContent || '', snapshot: readSnapshotSync() });
  if (!result.ok) return false;

  modal.setAttribute(PROCESSED_ATTR, 'verified');
  rewriteAsQueuedSuccess(modal, result);
  persistSuccessMarker(result);
  showSuccessToast({ code: result?.identity?.code || result?.queued?.code || '' });

  window.setTimeout(() => {
    try {
      if (!document.documentElement.contains(modal)) return;
      const continueButton = Array.from(modal.querySelectorAll('button')).find((button) => {
        const label = normalizeText(button.textContent || '');
        return label === 'VAZHDO TE PASTRIMI' || label === 'VAZHDO';
      });
      continueButton?.click?.();
    } catch {}
  }, 550);
  return true;
}

export function installOfflineQueuedOrderUiGuard() {
  if (!isBrowser()) return () => {};

  const scan = () => {
    try {
      const path = String(window.location?.pathname || '');
      if (path !== '/pranimi' && !path.startsWith('/pranimi/')) return;
      const modal = findNormalOfflineModal();
      if (modal) processModal(modal);
    } catch {}
  };

  scan();
  const Observer = globalThis.MutationObserver;
  if (typeof Observer !== 'function') return () => {};
  const observer = new Observer(() => scan());
  const target = document.getElementById('root') || document.body || document.documentElement;
  if (target) observer.observe(target, { childList: true, subtree: true, characterData: true });

  const onOutbox = () => scan();
  try { window.addEventListener('tepiha:outbox-changed', onOutbox, { passive: true }); } catch {}

  return () => {
    try { observer.disconnect(); } catch {}
    try { window.removeEventListener('tepiha:outbox-changed', onOutbox); } catch {}
  };
}

export default {
  extractOfflineQueuedWarningIdentity,
  findMatchingQueuedBaseInsert,
  inspectOfflineQueuedSuccess,
  installOfflineQueuedOrderUiGuard,
};
