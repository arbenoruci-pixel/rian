// lib/transportOfflineSync.js
// TEPIHA — Transport offline drafts → Supabase sync
// Uses the same atomic save path as Self Entry/Dispatch so an existing phone
// always keeps its permanent T-code and a temporary code can be released safely.

import { insertTransportOrder } from '@/lib/transport/transportDb';

const DRAFT_LIST_KEY = 'transport_draft_orders_v1';
const DRAFT_ITEM_PREFIX = 'transport_draft_order_';

function ensureDraftUuid(value) {
  const existing = String(value || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) return existing;
  try { if (globalThis?.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

function isBrowser() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function safeJsonParse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeTcode(value) {
  const digits = String(value || '').replace(/\D+/g, '').replace(/^0+/, '');
  return digits ? `T${digits}` : '';
}

function readDraftCode(draft = {}) {
  const data = asObject(draft?.data);
  const client = asObject(draft?.client);
  const dataClient = asObject(data?.client);
  return normalizeTcode(
    draft?.code_str ||
    draft?.client_tcode ||
    draft?.transport_client_tcode ||
    draft?.codeRaw ||
    draft?.tcode ||
    draft?.code ||
    data?.code_str ||
    data?.order_code ||
    data?.official_order_code ||
    data?.order_tcode ||
    data?.transport_client_tcode ||
    client?.tcode ||
    client?.code ||
    dataClient?.tcode ||
    dataClient?.code ||
    ''
  );
}

function readDraftPhone(draft = {}) {
  const data = asObject(draft?.data);
  const client = asObject(draft?.client);
  const dataClient = asObject(data?.client);
  const explicit = String(
    draft?.client_phone ||
    draft?.phoneFull ||
    draft?.phone_full ||
    data?.client_phone ||
    data?.phoneFull ||
    client?.phone ||
    dataClient?.phone ||
    ''
  ).trim();
  if (explicit) return explicit;

  const local = String(draft?.phone || data?.phone || '').trim();
  if (!local) return '';
  if (local.startsWith('+') || /^00\d+/.test(local) || /^383\d+/.test(local)) return local;

  const prefix = String(draft?.phonePrefix || draft?.phone_prefix || data?.phonePrefix || '+383').trim() || '+383';
  return `${prefix}${local}`;
}

function readDraftName(draft = {}) {
  const data = asObject(draft?.data);
  const client = asObject(draft?.client);
  const dataClient = asObject(data?.client);
  return String(
    draft?.client_name ||
    draft?.name ||
    data?.client_name ||
    client?.name ||
    dataClient?.name ||
    ''
  ).trim();
}

function persistDraftLocal(draft = {}) {
  if (!isBrowser()) return null;
  const id = ensureDraftUuid(draft?.id || draft?.oid || draft?.local_oid);
  const next = { ...draft, id, oid: draft?.oid || id, local_oid: draft?.local_oid || id };
  try {
    localStorage.setItem(`${DRAFT_ITEM_PREFIX}${id}`, JSON.stringify(next));
    const rawList = safeJsonParse(localStorage.getItem(DRAFT_LIST_KEY) || '[]', []);
    const ids = Array.isArray(rawList)
      ? rawList.map((entry) => typeof entry === 'string' ? entry : entry?.id).filter(Boolean)
      : [];
    if (!ids.includes(id)) ids.unshift(id);
    localStorage.setItem(DRAFT_LIST_KEY, JSON.stringify(ids));
  } catch {}
  return next;
}

function removeDraftLocal(id) {
  if (!isBrowser()) return;
  const key = String(id || '').trim();
  if (!key) return;
  try {
    localStorage.removeItem(`${DRAFT_ITEM_PREFIX}${key}`);
    const rawList = safeJsonParse(localStorage.getItem(DRAFT_LIST_KEY) || '[]', []);
    const ids = Array.isArray(rawList)
      ? rawList.map((entry) => typeof entry === 'string' ? entry : entry?.id).filter(Boolean)
      : [];
    localStorage.setItem(DRAFT_LIST_KEY, JSON.stringify(ids.filter((entryId) => entryId !== key)));
  } catch {}
}

function readDrafts() {
  if (!isBrowser()) return [];
  try {
    const rawList = safeJsonParse(localStorage.getItem(DRAFT_LIST_KEY) || '[]', []);
    if (!Array.isArray(rawList)) return [];

    const drafts = [];
    for (const entry of rawList) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const migrated = persistDraftLocal(entry);
        if (migrated) drafts.push(migrated);
        continue;
      }

      const id = String(entry || '').trim();
      if (!id) continue;
      const row = safeJsonParse(localStorage.getItem(`${DRAFT_ITEM_PREFIX}${id}`) || 'null', null);
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        drafts.push({ ...row, id: ensureDraftUuid(row?.id || id) });
      }
    }
    return drafts;
  } catch {
    return [];
  }
}

// Best effort for connectivity failures only. Identity conflicts and invalid
// phone data remain local and are retried after the operator corrects them.
export async function syncTransportDraftsNow({ limit = 50 } = {}) {
  if (!isBrowser()) return { ok: true, synced: 0 };
  if (!navigator.onLine) return { ok: true, synced: 0 };

  const drafts = readDrafts();
  if (!drafts.length) return { ok: true, synced: 0 };

  let synced = 0;
  const batch = drafts.slice(0, Math.max(1, Number(limit) || 50));

  for (const draft of batch) {
    const draftWithId = persistDraftLocal({
      ...draft,
      id: ensureDraftUuid(draft?.id || draft?.oid || draft?.local_oid),
    });
    if (!draftWithId) continue;

    try {
      const tcode = readDraftCode(draftWithId);
      // Never invent a code in the draft synchronizer. The normal Self Entry
      // flow assigns one; drafts without a code remain local.
      if (!tcode) continue;

      const phone = readDraftPhone(draftWithId);
      const result = await insertTransportOrder({
        id: draftWithId.id,
        code_str: tcode,
        client_name: readDraftName(draftWithId),
        client_phone: phone,
        status: draftWithId?.status || draftWithId?.data?.status || 'new',
        data: {
          ...asObject(draftWithId?.data),
          ...draftWithId,
          order_id: draftWithId.id,
          public_order_id: draftWithId.id,
          code_str: tcode,
          client_phone: phone,
        },
        code_owner: draftWithId?.created_by_pin || draftWithId?.transport_pin || draftWithId?.data?.created_by_pin || '',
      });
      if (!result?.ok) throw new Error(result?.error || 'TRANSPORT_DRAFT_SYNC_FAILED');

      removeDraftLocal(draftWithId.id);
      synced += 1;
    } catch {
      // The stable UUID stays persisted, so a lost response cannot create a duplicate.
      persistDraftLocal(draftWithId);
    }
  }

  return { ok: true, synced };
}
