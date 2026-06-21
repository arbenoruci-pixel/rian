import assert from 'node:assert/strict';
import { reserveBaseCodesForPin } from '../lib/baseCodeAllocatorServer.js';
import { runPranimiCodeReserveAction } from '../lib/pranimiCodeReserveServer.js';

function fakeSupabase({ rpcResult, rpcError, active = true } = {}) {
  const calls = { tables: [], rpc: [] };
  const client = {
    from(table) {
      calls.tables.push(table);
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        limit() { return chain; },
        async maybeSingle() { return { data: { id: 'f02ac388-f7bd-4636-8ae8-09d8f2a07ad9', pin: '1126', role: 'PUNTOR', name: 'fitim oruci', is_active: active }, error: null }; },
      };
      return chain;
    },
    async rpc(fn, args) {
      calls.rpc.push({ fn, args });
      if (rpcError) return { data: null, error: rpcError };
      return { data: rpcResult ?? [{ code: 1002, status: 'reserved', reserved_by: '1126', draft_session_id: 'draft-fitim', lease_expires_at: new Date(Date.now() + 3600000).toISOString(), verified: true }], error: null };
    },
  };
  return { client, calls };
}

// One PIN + one draft + one RPC + exactly one returned code.
{
  const h = fakeSupabase();
  const result = await reserveBaseCodesForPin({ pin: '1126', count: 1, draftSessionId: 'draft-fitim' }, { supabase: h.client });
  assert.equal(result.ok, true);
  assert.equal(result.code, 1002);
  assert.deepEqual(result.codes, [1002]);
  assert.equal(h.calls.rpc.length, 1);
  assert.deepEqual(h.calls.rpc[0], { fn: 'get_or_assign_pranimi_code', args: { p_pin: '1126', p_draft_session_id: 'draft-fitim', p_lease_minutes: 30 } });
}

// Compatibility route delegates to the exact same official function.
{
  const h = fakeSupabase();
  const result = await runPranimiCodeReserveAction({ actor_pin: '1126', p_count: 1, local_oid: 'draft-fitim' }, { supabase: h.client });
  assert.equal(result.ok, true);
  assert.equal(result.code, 1002);
  assert.equal(h.calls.rpc.length, 1);
  assert.equal(h.calls.rpc[0].fn, 'get_or_assign_pranimi_code');
}

// Count zero is a non-mutating probe; count >1 is forbidden.
{
  const h = fakeSupabase();
  const zero = await reserveBaseCodesForPin({ pin: '1126', count: 0, draftSessionId: 'd' }, { supabase: h.client });
  assert.deepEqual(zero.codes, []);
  assert.equal(zero.source, 'NOOP_ZERO_COUNT');
  assert.equal(h.calls.rpc.length, 0);
  await assert.rejects(reserveBaseCodesForPin({ pin: '1126', count: 20, draftSessionId: 'd' }, { supabase: h.client }), (e) => e?.message === 'PRANIMI_SINGLE_CODE_ONLY');
}

// PIN-only and draft-required: UUID and numeric owner_id alias cannot enter.
{
  const h = fakeSupabase();
  await assert.rejects(reserveBaseCodesForPin({ pin: 'f02ac388-f7bd-4636-8ae8-09d8f2a07ad9', count: 1, draftSessionId: 'd' }, { supabase: h.client }), (e) => e?.message === 'PIN_REQUIRED_OR_INVALID');
  await assert.rejects(reserveBaseCodesForPin({ owner_id: '1126', count: 1, draftSessionId: 'd' }, { supabase: h.client }), (e) => e?.message === 'PIN_REQUIRED_OR_INVALID');
  await assert.rejects(reserveBaseCodesForPin({ pin: '1126', count: 1 }, { supabase: h.client }), (e) => e?.message === 'DRAFT_SESSION_REQUIRED');
  assert.equal(h.calls.rpc.length, 0);
}

// RPC timeout/error is ambiguous and must not try another allocator/signature.
{
  const h = fakeSupabase({ rpcError: { code: '57014', message: 'statement timeout after dispatch' } });
  await assert.rejects(reserveBaseCodesForPin({ pin: '1126', count: 1, draftSessionId: 'draft-fitim' }, { supabase: h.client }), (e) => e?.message === 'PRANIMI_ASSIGNMENT_RESULT_AMBIGUOUS');
  assert.equal(h.calls.rpc.length, 1);
}

// Deterministic DB policy errors preserve their symbolic code and never retry another path.
{
  const h = fakeSupabase({ rpcError: { code: 'P0001', message: 'PIN_ACTIVE_DRAFT_EXISTS:1126:other-draft' } });
  await assert.rejects(
    reserveBaseCodesForPin({ pin: '1126', count: 1, draftSessionId: 'draft-fitim' }, { supabase: h.client }),
    (e) => e?.message === 'PIN_ACTIVE_DRAFT_EXISTS' && e?.code === 'PIN_ACTIVE_DRAFT_EXISTS' && e?.status === 409,
  );
  assert.equal(h.calls.rpc.length, 1);
}

// Identity mismatch is blocked: wrong PIN/session/status can never be displayed.
{
  const h = fakeSupabase({ rpcResult: [{ code: 1002, status: 'reserved', reserved_by: '2380', draft_session_id: 'other', lease_expires_at: new Date(Date.now() + 3600000).toISOString(), verified: true }] });
  await assert.rejects(reserveBaseCodesForPin({ pin: '1126', count: 1, draftSessionId: 'draft-fitim' }, { supabase: h.client }), (e) => e?.message === 'DB_ASSIGNMENT_IDENTITY_MISMATCH');
  assert.equal(h.calls.rpc.length, 1);
}

// Disabled PIN is rejected before mutation.
{
  const h = fakeSupabase({ active: false });
  await assert.rejects(reserveBaseCodesForPin({ pin: '1126', count: 1, draftSessionId: 'draft-fitim' }, { supabase: h.client }), (e) => e?.message === 'PIN_DISABLED');
  assert.equal(h.calls.rpc.length, 0);
}

console.log('PRANIMI server reservation V39.1 PRO regression checks: PASS');
