'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

export const dynamic = 'force-dynamic';

const KNOWN_INDEXED_DB_NAMES = [
  'tepiha_offline_db',
  'localforage',
  'keyval-store',
  'firebaseLocalStorageDb',
];

const SENSITIVE_FIELD_RE = /(access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|authorization|bearer|jwt|service[_-]?role|private[_-]?key)/i;
const PHONE_RE = /(\+?383[\d\s().-]{6,}|0[\d\s().-]{7,})/g;

const btn = {
  border: '1px solid rgba(255,255,255,.16)',
  background: 'rgba(255,255,255,.08)',
  color: '#fff',
  borderRadius: 14,
  padding: '11px 13px',
  fontWeight: 950,
  letterSpacing: 1,
  textTransform: 'uppercase',
};

const card = {
  border: '1px solid rgba(255,255,255,.12)',
  background: 'rgba(255,255,255,.055)',
  borderRadius: 18,
  padding: 14,
};

function nowIso() {
  try { return new Date().toISOString(); } catch { return ''; }
}

function safeString(value) {
  try {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    return String(value);
  } catch {
    return '';
  }
}

function safeJsonParse(raw) {
  try {
    if (typeof raw !== 'string') return { ok: false, value: raw };
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, value: raw };
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && trimmed !== 'null' && trimmed !== 'true' && trimmed !== 'false') {
      return { ok: false, value: raw };
    }
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, value: raw };
  }
}

function sanitizeForExport(value, path = '') {
  const keyName = String(path.split('.').pop() || '');
  if (SENSITIVE_FIELD_RE.test(keyName)) return '[REDACTED]';
  if (value == null) return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item, index) => sanitizeForExport(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeForExport(v, path ? `${path}.${k}` : k);
    }
    return out;
  }
  return safeString(value);
}

function jsonText(value, pretty = true) {
  try {
    return JSON.stringify(value, null, pretty ? 2 : 0);
  } catch (error) {
    return JSON.stringify({ stringify_error: safeString(error?.message || error), value: safeString(value) }, null, 2);
  }
}

function bytesOf(value) {
  try { return new Blob([safeString(value)]).size; } catch { return safeString(value).length; }
}

function readStorageArea(area, label) {
  const rows = [];
  try {
    if (!area) return rows;
    for (let i = 0; i < area.length; i += 1) {
      const key = area.key(i);
      if (!key) continue;
      let raw = null;
      try { raw = area.getItem(key); } catch (error) { raw = `READ_ERROR: ${safeString(error?.message || error)}`; }
      const parsed = safeJsonParse(raw);
      rows.push({
        source: label,
        key,
        bytes: bytesOf(raw),
        parsed: parsed.ok,
        value: sanitizeForExport(parsed.value, key),
      });
    }
  } catch (error) {
    rows.push({ source: label, key: '__READ_ERROR__', bytes: 0, parsed: false, value: safeString(error?.message || error) });
  }
  rows.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return rows;
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

async function getIndexedDbNames() {
  const names = new Set();
  try {
    if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases();
      (dbs || []).forEach((db) => {
        if (db?.name) names.add(String(db.name));
      });
    }
  } catch {}
  KNOWN_INDEXED_DB_NAMES.forEach((name) => names.add(name));
  return Array.from(names).filter(Boolean);
}

async function openExistingDatabase(name) {
  return new Promise((resolve) => {
    let abortedBecauseMissing = false;
    let req;
    try {
      req = indexedDB.open(name);
    } catch (error) {
      resolve({ db: null, error: safeString(error?.message || error), missing: false });
      return;
    }

    req.onupgradeneeded = () => {
      abortedBecauseMissing = true;
      try { req.transaction.abort(); } catch {}
    };
    req.onsuccess = () => resolve({ db: req.result, error: '', missing: false });
    req.onerror = () => resolve({
      db: null,
      error: abortedBecauseMissing ? 'DATABASE_NOT_FOUND_OR_EMPTY' : safeString(req.error?.message || req.error || 'OPEN_FAILED'),
      missing: abortedBecauseMissing,
    });
    req.onblocked = () => resolve({ db: null, error: 'OPEN_BLOCKED_BY_ANOTHER_TAB', missing: false });
  });
}

async function dumpIndexedDb() {
  const out = [];
  if (typeof indexedDB === 'undefined') return [{ name: '__NO_INDEXED_DB__', error: 'IndexedDB nuk ekziston në këtë browser', stores: [] }];

  const names = await getIndexedDbNames();
  for (const name of names) {
    const dbResult = await openExistingDatabase(name);
    if (!dbResult.db) {
      if (!dbResult.missing) out.push({ name, error: dbResult.error, stores: [] });
      continue;
    }

    const db = dbResult.db;
    const stores = [];
    try {
      const storeNames = Array.from(db.objectStoreNames || []);
      for (const storeName of storeNames) {
        const rows = [];
        try {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const req = store.openCursor();
          await new Promise((resolve, reject) => {
            req.onsuccess = () => {
              const cursor = req.result;
              if (!cursor) return resolve();
              rows.push({
                key: sanitizeForExport(cursor.key, `${name}.${storeName}.key`),
                value: sanitizeForExport(cursor.value, `${name}.${storeName}.value`),
              });
              cursor.continue();
            };
            req.onerror = () => reject(req.error || new Error('Cursor failed'));
          });
          await txDone(tx);
          stores.push({ store: storeName, count: rows.length, rows });
        } catch (error) {
          stores.push({ store: storeName, count: rows.length, error: safeString(error?.message || error), rows });
        }
      }
      out.push({ name, version: db.version, stores });
    } finally {
      try { db.close(); } catch {}
    }
  }
  return out;
}

async function dumpCaches() {
  const out = [];
  try {
    if (!('caches' in window)) return [];
    const names = await caches.keys();
    for (const cacheName of names) {
      try {
        const cache = await caches.open(cacheName);
        const requests = await cache.keys();
        out.push({ cacheName, count: requests.length, urls: requests.map((r) => safeString(r?.url || r)).slice(0, 1000) });
      } catch (error) {
        out.push({ cacheName, error: safeString(error?.message || error), urls: [] });
      }
    }
  } catch (error) {
    out.push({ cacheName: '__CACHE_READ_ERROR__', error: safeString(error?.message || error), urls: [] });
  }
  return out;
}

function lowerKey(key) {
  return String(key || '').toLowerCase().replace(/[\s_-]+/g, '');
}

function findFirstDeep(value, wantedKeys, depth = 0, seen = new WeakSet()) {
  if (value == null || depth > 8) return null;
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstDeep(item, wantedKeys, depth + 1, seen);
      if (found != null && found !== '') return found;
    }
    return null;
  }

  for (const [k, v] of Object.entries(value)) {
    const lk = lowerKey(k);
    if (wantedKeys.includes(lk) && v != null && typeof v !== 'object' && safeString(v).trim()) return v;
  }
  for (const v of Object.values(value)) {
    const found = findFirstDeep(v, wantedKeys, depth + 1, seen);
    if (found != null && found !== '') return found;
  }
  return null;
}

function toRecordText(value) {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  } catch {
    return safeString(value);
  }
}

function normalizePhone(raw) {
  const text = safeString(raw).trim();
  if (!text) return '';
  const m = text.match(PHONE_RE);
  const first = m?.[0] || text;
  return first.replace(/[^+\d]/g, '');
}

function makeCandidate({ source, location, value }) {
  const text = toRecordText(value);
  const name = findFirstDeep(value, ['clientname', 'fullname', 'firstname', 'name', 'klienti', 'customername', 'emri']);
  const phone = findFirstDeep(value, ['phone', 'telefoni', 'tel', 'phonedigits', 'clientphone']);
  const code = findFirstDeep(value, ['code', 'coden', 'codestr', 'clientcode', 'kodi']);
  const status = findFirstDeep(value, ['status', 'state']);
  const m2 = findFirstDeep(value, ['m2', 'm2total', 'totalm2']);
  const euro = findFirstDeep(value, ['euro', 'price', 'pricetotal', 'amount', 'total']);
  const oid = findFirstDeep(value, ['localoid', 'oid', 'id', 'opid', 'deadid']);
  const phoneFromText = normalizePhone(text.match(PHONE_RE)?.[0] || '');

  const hasUseful = !!(
    safeString(name).trim() ||
    safeString(phone).trim() ||
    phoneFromText ||
    safeString(code).trim()
  );
  if (!hasUseful) return null;

  return {
    source,
    location,
    code: safeString(code).trim(),
    name: safeString(name).trim(),
    phone: normalizePhone(phone) || phoneFromText,
    status: safeString(status).trim(),
    m2: safeString(m2).trim(),
    euro: safeString(euro).trim(),
    local_oid: safeString(oid).trim(),
  };
}

function collectCandidates(snapshot) {
  const candidates = [];
  const add = (item) => {
    const key = `${item?.source || ''}|${item?.location || ''}|${item?.code || ''}|${item?.phone || ''}|${item?.name || ''}`;
    if (!item || candidates.some((x) => x.__key === key)) return;
    candidates.push({ ...item, __key: key });
  };

  for (const row of snapshot.localStorage || []) {
    add(makeCandidate({ source: 'localStorage', location: row.key, value: row.value }));
  }
  for (const row of snapshot.sessionStorage || []) {
    add(makeCandidate({ source: 'sessionStorage', location: row.key, value: row.value }));
  }
  for (const db of snapshot.indexedDB || []) {
    for (const store of db.stores || []) {
      for (const row of store.rows || []) {
        add(makeCandidate({ source: `IndexedDB:${db.name}/${store.store}`, location: safeString(row.key), value: row.value }));
      }
    }
  }

  return candidates
    .map(({ __key, ...item }) => item)
    .sort((a, b) => `${a.source} ${a.location}`.localeCompare(`${b.source} ${b.location}`));
}

function makeHumanReport(snapshot, candidates) {
  const lines = [];
  lines.push('TEPIHA LOCAL DUMP — KANDIDATË EMËR / TELEFON / KOD');
  lines.push(`KOHA: ${snapshot.created_at}`);
  lines.push(`URL: ${snapshot.location?.href || ''}`);
  lines.push(`DEVICE: ${snapshot.device?.userAgent || ''}`);
  lines.push(`ONLINE: ${snapshot.device?.online}`);
  lines.push('');
  lines.push(`KANDIDATË: ${candidates.length}`);
  lines.push(`localStorage keys: ${snapshot.localStorage?.length || 0}`);
  lines.push(`sessionStorage keys: ${snapshot.sessionStorage?.length || 0}`);
  lines.push(`IndexedDB rows: ${snapshot.summary?.indexedDbRows || 0}`);
  lines.push('');
  if (!candidates.length) {
    lines.push('NUK U GJETËN KANDIDATË ME EMËR/TELEFON/KOD NË LOCAL DATA. SHIKO FULL JSON MË POSHTË.');
  } else {
    candidates.forEach((c, idx) => {
      lines.push(`${idx + 1}. ${c.code || '—'} | ${c.name || '—'} | ${c.phone || '—'} | status=${c.status || '—'} | m2=${c.m2 || '—'} | €=${c.euro || '—'}`);
      lines.push(`   ${c.source} :: ${c.location}`);
    });
  }
  return lines.join('\n');
}

async function makeSnapshot() {
  const localStorageRows = readStorageArea(window.localStorage, 'localStorage');
  const sessionStorageRows = readStorageArea(window.sessionStorage, 'sessionStorage');
  const indexedDBRows = await dumpIndexedDb();
  const cacheRows = await dumpCaches();
  const indexedDbRowsCount = indexedDBRows.reduce((sum, db) => sum + (db.stores || []).reduce((s, st) => s + (st.rows?.length || 0), 0), 0);
  return {
    kind: 'TEPIHA_LOCAL_PHONE_DUMP_READ_ONLY_V1',
    created_at: nowIso(),
    location: {
      href: safeString(window.location?.href || ''),
      path: safeString(window.location?.pathname || ''),
    },
    device: {
      userAgent: safeString(navigator.userAgent || ''),
      platform: safeString(navigator.platform || ''),
      language: safeString(navigator.language || ''),
      online: !!navigator.onLine,
      visibilityState: safeString(document.visibilityState || ''),
      standalone: !!(navigator.standalone || window.matchMedia?.('(display-mode: standalone)')?.matches),
    },
    summary: {
      localStorageKeys: localStorageRows.length,
      sessionStorageKeys: sessionStorageRows.length,
      indexedDbDatabases: indexedDBRows.length,
      indexedDbRows: indexedDbRowsCount,
      caches: cacheRows.length,
    },
    localStorage: localStorageRows,
    sessionStorage: sessionStorageRows,
    indexedDB: indexedDBRows,
    caches: cacheRows,
  };
}

export default function NxirrLocalPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [copied, setCopied] = useState('');
  const fullRef = useRef(null);
  const humanRef = useRef(null);

  const candidates = useMemo(() => (snapshot ? collectCandidates(snapshot) : []), [snapshot]);
  const humanText = useMemo(() => (snapshot ? makeHumanReport(snapshot, candidates) : ''), [snapshot, candidates]);
  const fullText = useMemo(() => (snapshot ? jsonText({ ...snapshot, candidates }, true) : ''), [snapshot, candidates]);

  async function scan() {
    setLoading(true);
    setError('');
    setCopied('');
    try {
      const data = await makeSnapshot();
      setSnapshot(data);
    } catch (err) {
      setError(safeString(err?.message || err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    scan();
  }, []);

  async function copyText(text, label, ref) {
    setCopied('');
    try {
      await navigator.clipboard.writeText(text || '');
      setCopied(`${label} U KOPJUA`);
    } catch {
      try {
        ref?.current?.focus?.();
        ref?.current?.select?.();
        document.execCommand('copy');
        setCopied(`${label} U KOPJUA`);
      } catch {
        setCopied('SHTYPE TEKSTIN, SELECT ALL, COPY');
      }
    }
  }

  function downloadJson() {
    try {
      const blob = new Blob([fullText || '{}'], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tepiha-local-dump-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (err) {
      setError(safeString(err?.message || err));
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#05070d', color: '#fff', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial', padding: 14 }}>
      <div style={{ maxWidth: 980, margin: '0 auto', display: 'grid', gap: 12 }}>
        <div style={{ ...card, background: 'linear-gradient(180deg, rgba(37,99,235,.22), rgba(255,255,255,.04))' }}>
          <div style={{ fontSize: 22, fontWeight: 1000, letterSpacing: 2, textTransform: 'uppercase' }}>NXIRR TË DHËNAT NGA KY TELEFON</div>
          <div style={{ marginTop: 8, opacity: 0.9, lineHeight: 1.45, fontWeight: 750 }}>
            Kjo faqe vetëm lexon të dhënat lokale në këtë pajisje: localStorage, sessionStorage, IndexedDB dhe cache listën. Nuk shkruan në DB, nuk krijon porosi, nuk ndryshon kode, nuk e prek operimin.
          </div>
        </div>

        <div style={{ ...card, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button style={btn} onClick={scan} disabled={loading}>{loading ? 'DUKE LEXUAR…' : 'RIFRESKO'}</button>
            <button style={btn} onClick={() => copyText(humanText, 'KANDIDATËT', humanRef)} disabled={!humanText}>COPY KANDIDATËT</button>
            <button style={btn} onClick={() => copyText(fullText, 'FULL DUMP', fullRef)} disabled={!fullText}>COPY FULL DUMP</button>
            <button style={btn} onClick={downloadJson} disabled={!fullText}>SHKARKO JSON</button>
          </div>
          {copied ? <div style={{ color: '#86efac', fontWeight: 1000 }}>{copied}</div> : null}
          {error ? <div style={{ color: '#fca5a5', fontWeight: 900, whiteSpace: 'pre-wrap' }}>{error}</div> : null}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
          <div style={card}><div style={{ opacity: .65, fontSize: 12 }}>KANDIDATË</div><div style={{ fontSize: 24, fontWeight: 1000 }}>{candidates.length}</div></div>
          <div style={card}><div style={{ opacity: .65, fontSize: 12 }}>LOCAL KEYS</div><div style={{ fontSize: 24, fontWeight: 1000 }}>{snapshot?.summary?.localStorageKeys ?? '—'}</div></div>
          <div style={card}><div style={{ opacity: .65, fontSize: 12 }}>IDB ROWS</div><div style={{ fontSize: 24, fontWeight: 1000 }}>{snapshot?.summary?.indexedDbRows ?? '—'}</div></div>
          <div style={card}><div style={{ opacity: .65, fontSize: 12 }}>CACHE</div><div style={{ fontSize: 24, fontWeight: 1000 }}>{snapshot?.summary?.caches ?? '—'}</div></div>
        </div>

        <div style={card}>
          <div style={{ fontWeight: 1000, letterSpacing: 1, marginBottom: 8 }}>1) COPY KANDIDATËT — EMËR / TEL / KOD</div>
          <textarea
            ref={humanRef}
            value={humanText || (loading ? 'DUKE LEXUAR…' : '')}
            readOnly
            spellCheck={false}
            style={{ width: '100%', minHeight: 260, boxSizing: 'border-box', borderRadius: 14, padding: 12, background: '#020617', color: '#e5e7eb', border: '1px solid rgba(255,255,255,.14)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12, lineHeight: 1.45 }}
          />
        </div>

        <div style={card}>
          <div style={{ fontWeight: 1000, letterSpacing: 1, marginBottom: 8 }}>2) COPY FULL DUMP — TË GJITHA TË DHËNAT LOKALE</div>
          <textarea
            ref={fullRef}
            value={fullText || (loading ? 'DUKE LEXUAR…' : '')}
            readOnly
            spellCheck={false}
            style={{ width: '100%', minHeight: 420, boxSizing: 'border-box', borderRadius: 14, padding: 12, background: '#020617', color: '#e5e7eb', border: '1px solid rgba(255,255,255,.14)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 11, lineHeight: 1.42 }}
          />
        </div>
      </div>
    </div>
  );
}
