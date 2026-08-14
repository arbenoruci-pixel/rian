import fs from 'node:fs';

const PATH = 'lib/homeSearch.js';
const MARKER = 'HOME_SEARCH_EXACT_DB_TRUTH_V3';
let src = fs.readFileSync(PATH, 'utf8');
if (src.includes(MARKER)) {
  console.log('[home-search-exact-db-truth-v3] already installed');
  process.exit(0);
}

function replaceOnce(oldText, newText, label) {
  const count = src.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  src = src.replace(oldText, newText);
  console.log(`PATCH ${label}`);
}

replaceOnce(
`async function getRowsFromDbExact(query, mode = getHomeSearchQueryMode(query)) {`,
`async function runHomeExactDbQuery(factory, { attempts = 2, timeoutMs = 7000, label = 'HOME_SEARCH_EXACT_DB_TIMEOUT' } = {}) {
  // ${MARKER}
  let lastError = null;
  const count = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt <= count; attempt += 1) {
    try {
      let request = factory();
      if (typeof request?.timeout === 'function') {
        request = request.timeout(attempt === 1 ? timeoutMs : Math.max(timeoutMs, 12000), label);
      }
      const response = await request;
      if (response?.error) throw response.error;
      return response?.data;
    } catch (error) {
      lastError = error;
      if (attempt < count) await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
    }
  }
  throw lastError || new Error(label);
}

async function getRowsFromDbExact(query, mode = getHomeSearchQueryMode(query)) {`,
'install exact DB retry helper'
);

replaceOnce(
`        const { data, error } = await supabase
          .from('orders')
          .select('id,code,client_name,client_phone,status,data,created_at,updated_at')
          .eq('code', codeNumber)
          .limit(10);

        if (!error && Array.isArray(data)) {
          rows.push(...data.map((row) => ({
            ...row,
            _table: 'orders',
            _homeSearchSource: 'db-exact-orders',
            _homeSearchSourceRank: 100,
          })));
        }`,
`        let data = null;
        let rpcError = null;
        try {
          data = await runHomeExactDbQuery(
            () => supabase.rpc('find_base_order_by_code_fast', { p_code: codeNumber }),
            { attempts: 2, timeoutMs: 6500, label: 'HOME_SEARCH_BASE_CODE_RPC_TIMEOUT' },
          );
        } catch (error) {
          rpcError = error;
        }

        // Compact indexed fallback keeps exact code search alive if an older client
        // hits a transient RPC/network edge. Do not fetch the large data JSON here.
        if (!Array.isArray(data)) {
          try {
            data = await runHomeExactDbQuery(
              () => supabase
                .from('orders')
                .select('id,local_oid,code,client_code,client_id,client_name,client_phone,status,pieces,m2_total,total,paid,ready_at,delivered_at,created_at,updated_at')
                .eq('code', codeNumber)
                .order('updated_at', { ascending: false })
                .limit(12),
              { attempts: 2, timeoutMs: 7500, label: 'HOME_SEARCH_BASE_CODE_FALLBACK_TIMEOUT' },
            );
          } catch (fallbackError) {
            try {
              console.warn('HOME_SEARCH_EXACT_BASE_DB_FAILED', {
                code: codeNumber,
                rpc: String(rpcError?.message || rpcError || ''),
                fallback: String(fallbackError?.message || fallbackError || ''),
              });
            } catch {}
            data = [];
          }
        }

        if (Array.isArray(data)) {
          rows.push(...data.map((row) => ({
            ...row,
            _table: 'orders',
            _homeSearchSource: 'db-exact-orders-fast',
            _homeSearchSourceRank: 120,
          })));
        }`,
'replace heavy one-shot base exact search with fast RPC plus retry fallback'
);

fs.writeFileSync(PATH, src, 'utf8');
const out = fs.readFileSync(PATH, 'utf8');
for (const token of [
  MARKER,
  "supabase.rpc('find_base_order_by_code_fast'",
  'HOME_SEARCH_BASE_CODE_RPC_TIMEOUT',
  'HOME_SEARCH_BASE_CODE_FALLBACK_TIMEOUT',
  "select('id,local_oid,code,client_code,client_id,client_name,client_phone,status,pieces,m2_total,total,paid,ready_at,delivered_at,created_at,updated_at')",
  "_homeSearchSource: 'db-exact-orders-fast'",
]) {
  if (!out.includes(token)) throw new Error(`VERIFY_MISSING:${token}`);
}
if (out.includes(".select('id,code,client_name,client_phone,status,data,created_at,updated_at')\n          .eq('code', codeNumber)")) {
  throw new Error('heavy exact base search still present');
}
console.log('PASS Home exact base search uses fast DB truth, retries and compact indexed fallback');
