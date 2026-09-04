#!/usr/bin/env python3
from pathlib import Path
import re
import textwrap

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


PAYROLL_ADVANCE_MODULE = textwrap.dedent(r'''
    const PAYROLL_ADMIN_ROLES = new Set([
      'ADMIN', 'ADMIN_MASTER', 'ADMINMASTER', 'ADMINISTRATOR', 'DISPATCH',
      'MASTER', 'MASTER_USER', 'MASTERUSER', 'OWNER', 'PRONAR',
      'SUPERADMIN', 'SUPER_ADMIN',
    ]);

    function clean(value, fallback = '') {
      const result = String(value ?? '').trim();
      return result || fallback;
    }

    function normalizePin(value) {
      return clean(value).replace(/\D/g, '');
    }

    function normalizeRole(value) {
      return clean(value)
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
    }

    function normalizeMoney(value) {
      const result = Number(String(value ?? '').replace(',', '.'));
      return Number.isFinite(result)
        ? Math.round((result + Number.EPSILON) * 100) / 100
        : 0;
    }

    function isSchemaCompatibilityError(error) {
      const code = clean(error?.code).toUpperCase();
      const message = clean(error?.message || error?.details || error?.hint || error).toLowerCase();
      return ['42703', 'PGRST202', 'PGRST204'].includes(code) ||
        message.includes('schema cache') ||
        (message.includes('column') && message.includes('does not exist'));
    }

    function createActionId(workerPin) {
      try {
        if (globalThis.crypto?.randomUUID) {
          return `payroll-advance:${workerPin}:${globalThis.crypto.randomUUID()}`;
        }
      } catch {}
      return `payroll-advance:${workerPin}:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
    }

    async function verifyPayrollActor(supabase, actor = {}) {
      const actorPin = normalizePin(actor.pin);
      if (!actorPin) throw new Error('ACTOR_PIN_REQUIRED');

      let result = await supabase
        .from('users')
        .select('id,pin,name,role,is_active')
        .eq('pin', actorPin)
        .maybeSingle();

      if (result?.error && isSchemaCompatibilityError(result.error)) {
        result = await supabase
          .from('users')
          .select('id,pin,name,role')
          .eq('pin', actorPin)
          .maybeSingle();
      }

      if (result?.error) throw result.error;
      const row = result?.data;
      if (!row?.pin) throw new Error('ACTOR_NOT_FOUND');
      if (Object.prototype.hasOwnProperty.call(row, 'is_active') && row.is_active === false) {
        throw new Error('ACTOR_DISABLED');
      }

      const actorRole = normalizeRole(row.role || actor.role);
      const compactRole = actorRole.replace(/_/g, '');
      if (!PAYROLL_ADMIN_ROLES.has(actorRole) && !PAYROLL_ADMIN_ROLES.has(compactRole)) {
        throw new Error('ACTOR_ROLE_NOT_ALLOWED');
      }

      return {
        pin: normalizePin(row.pin),
        name: clean(row.name, clean(actor.name, actorPin)),
        role: actorRole,
      };
    }

    /**
     * Records a payroll advance without any daily arka cycle.
     * No open-day lookup, close-day lookup, cycle_id, or applied_cycle_id is used.
     */
    export async function createPayrollAdvanceCycleFree({
      supabase,
      actor,
      worker,
      amount,
      note = 'AVANS',
    } = {}) {
      if (!supabase?.from) throw new Error('SUPABASE_CLIENT_REQUIRED');

      const verifiedActor = await verifyPayrollActor(supabase, actor);
      const workerPin = normalizePin(worker?.pin);
      const workerName = clean(worker?.name, workerPin);
      const cleanAmount = normalizeMoney(amount);
      if (!workerPin || !workerName) throw new Error('WORKER_REQUIRED');
      if (!(cleanAmount > 0)) throw new Error('ADVANCE_AMOUNT_REQUIRED');

      const createdAt = new Date().toISOString();
      const idempotencyKey = createActionId(workerPin);
      const cleanNote = clean(note, 'AVANS');
      const variants = [
        {
          amount: cleanAmount,
          type: 'ADVANCE',
          status: 'ADVANCE',
          method: 'CASH',
          note: cleanNote,
          created_by_pin: workerPin,
          created_by_name: workerName,
          created_by_role: 'WORKER',
          actor_pin: verifiedActor.pin,
          actor_name: verifiedActor.name,
          source: 'PAYROLL',
          source_module: 'ARKA',
          source_ref: idempotencyKey,
          idempotency_key: idempotencyKey,
          client_name: workerName,
          created_at: createdAt,
          updated_at: createdAt,
        },
        {
          amount: cleanAmount,
          type: 'ADVANCE',
          status: 'ADVANCE',
          note: cleanNote,
          created_by_pin: workerPin,
          created_by_name: workerName,
          actor_pin: verifiedActor.pin,
          actor_name: verifiedActor.name,
          source_module: 'ARKA',
          idempotency_key: idempotencyKey,
          client_name: workerName,
          created_at: createdAt,
        },
        {
          amount: cleanAmount,
          type: 'ADVANCE',
          status: 'ADVANCE',
          note: cleanNote,
          created_by_pin: workerPin,
          created_by_name: workerName,
          client_name: workerName,
          created_at: createdAt,
        },
      ];

      let lastError = null;
      for (const row of variants) {
        const result = await supabase.from('arka_pending_payments').insert(row);
        if (!result?.error) {
          return {
            ok: true,
            amount: cleanAmount,
            workerPin,
            workerName,
            actorPin: verifiedActor.pin,
            actorName: verifiedActor.name,
            idempotencyKey,
          };
        }
        lastError = result.error;
        if (isSchemaCompatibilityError(result.error)) continue;
        throw result.error;
      }

      throw lastError || new Error('PAYROLL_ADVANCE_INSERT_FAILED');
    }
''').lstrip()


RETIRED_DAILY_PAGE = textwrap.dedent(r'''
    "use client";

    import Link from "@/lib/routerCompat.jsx";

    export default function RetiredArkaDailyClosePage() {
      return (
        <main style={{ minHeight: '100vh', background: '#05070d', color: '#f8fafc', display: 'grid', placeItems: 'center', padding: 20 }}>
          <section style={{ width: 'min(520px, 100%)', border: '1px solid #243044', borderRadius: 22, padding: 22, background: '#0b1120' }}>
            <h1 style={{ margin: 0, fontSize: 26 }}>Arka funksionon vazhdimisht</h1>
            <p style={{ color: '#cbd5e1', lineHeight: 1.55 }}>Qel/mbyllja ditore është larguar. Pagesat, avanset dhe shpenzimet regjistrohen me datën dhe orën reale.</p>
            <Link prefetch={false} href="/arka" style={{ display: 'block', textAlign: 'center', textDecoration: 'none', borderRadius: 14, padding: 13, background: '#2563eb', color: '#fff', fontWeight: 900 }}>KTHEHU NË ARKË</Link>
          </section>
        </main>
      );
    }
''').lstrip()


def patch_payroll() -> None:
    path = 'app/arka/payroll/page.jsx'
    source = read(path)

    import_line = 'import { createPayrollAdvanceCycleFree } from "@/lib/arka/payrollAdvance";\n'
    if import_line not in source:
        anchor = 'import { arkaTransaction, buildArkaIdempotencyKey } from "@/lib/arka/arkaClient";\n'
        if anchor not in source:
            raise RuntimeError('Payroll arkaClient import anchor not found')
        source = source.replace(anchor, anchor + import_line, 1)

    source = source.replace(
        "['ADMIN', 'ADMIN_MASTER', 'DISPATCH', 'OWNER', 'PRONAR', 'SUPERADMIN']",
        "['ADMIN', 'ADMIN_MASTER', 'ADMINISTRATOR', 'DISPATCH', 'MASTER', 'MASTER_USER', 'OWNER', 'PRONAR', 'SUPERADMIN']",
    )
    source = source.replace(
        '["ADMIN", "ADMIN_MASTER", "DISPATCH", "OWNER", "PRONAR", "SUPERADMIN"]',
        '["ADMIN", "ADMIN_MASTER", "ADMINISTRATOR", "DISPATCH", "MASTER", "MASTER_USER", "OWNER", "PRONAR", "SUPERADMIN"]',
    )

    start = source.find('  async function handleAddAdvance()')
    end = source.find('\n  const payableAmount', start)
    if start < 0 or end < 0:
        raise RuntimeError('handleAddAdvance block not found')
    block = source[start:end]

    if 'createPayrollAdvanceCycleFree({' not in block:
        call_start = block.find('      await arkaTransaction({')
        if call_start < 0:
            raise RuntimeError('Legacy advance arkaTransaction call not found')
        brace_start = block.find('{', call_start)
        depth = 0
        call_end = None
        for index in range(brace_start, len(block)):
            char = block[index]
            if char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
                if depth == 0:
                    semicolon = block.find(';', index)
                    call_end = semicolon + 1
                    break
        if call_end is None:
            raise RuntimeError('Legacy advance call could not be parsed')

        replacement = textwrap.dedent('''
              await createPayrollAdvanceCycleFree({
                supabase,
                actor,
                worker: advanceModal,
                amount: amt,
                note: String(advanceNote || 'AVANS').trim() || 'AVANS',
              });
        ''').strip('\n')
        block = block[:call_start] + replacement + block[call_end:]
        source = source[:start] + block + source[end:]

    source = re.sub(
        r'\s*<Link\s+prefetch=\{false\}\s+href="/arka/ditore"\s+className="navBtn">MBYLLJA DITORE</Link>',
        '',
        source,
    )
    write(path, source)


def patch_guards() -> None:
    path = 'lib/arka/arkaGuards.js'
    source = read(path)
    if 'export function isLegacyArkaDayGuardError' not in source:
        marker = 'export function isMissingColumnOrFunctionError'
        position = source.find(marker)
        if position < 0:
            raise RuntimeError('isMissingColumnOrFunctionError not found')
        helper = textwrap.dedent('''
            export function isLegacyArkaDayGuardError(error) {
              const message = String(error?.message || error?.details || error?.hint || error || '').toLowerCase();
              return message.includes('arka_day_already_closed') ||
                message.includes('day_already_closed') ||
                message.includes('arka day already closed') ||
                message.includes('arka është mbyllur') ||
                message.includes('arka eshte mbyllur');
            }

        ''')
        source = source[:position] + helper + source[position:]

    match = re.search(r'export function isMissingColumnOrFunctionError\(([^)]*)\)\s*\{', source)
    if not match:
        raise RuntimeError('Compatibility guard could not be parsed')
    parameter = match.group(1).split(',')[0].strip() or 'error'
    injection = f'\n  if (isLegacyArkaDayGuardError({parameter})) return true;'
    if injection.strip() not in source[match.end():match.end() + 280]:
        source = source[:match.end()] + injection + source[match.end():]
    write(path, source)


def patch_engine() -> None:
    path = 'lib/arka/arkaEngine.js'
    source = read(path)
    if 'isLegacyArkaDayGuardError,' not in source:
        anchor = '  isMissingColumnOrFunctionError,\n'
        if anchor not in source:
            raise RuntimeError('arkaEngine guard import anchor not found')
        source = source.replace(anchor, '  isLegacyArkaDayGuardError,\n' + anchor, 1)

    marker = "function isMissingRpcFunctionError(error, functionName = '') {"
    position = source.find(marker)
    if position < 0:
        raise RuntimeError('isMissingRpcFunctionError not found')
    body = position + len(marker)
    injection = '\n  if (isLegacyArkaDayGuardError(error)) return true;'
    if injection.strip() not in source[body:body + 280]:
        source = source[:body] + injection + source[body:]

    marker = 'function pendingInsertVariants(payload = {}) {'
    position = source.find(marker)
    if position < 0:
        raise RuntimeError('pendingInsertVariants not found')
    body = position + len(marker)
    injection = "\n  payload = stripKeys(payload, ['cycle_id', 'applied_cycle_id']);"
    if injection.strip() not in source[body:body + 280]:
        source = source[:body] + injection + source[body:]
    write(path, source)


def verify() -> None:
    payroll = read('app/arka/payroll/page.jsx')
    start = payroll.find('async function handleAddAdvance')
    end = payroll.find('const payableAmount', start)
    block = payroll[start:end]
    assert 'createPayrollAdvanceCycleFree({' in block
    assert 'ARKA_ACTION.EXPENSE_REQUEST' not in block
    assert not any(token in block for token in ('cycle_id', 'applied_cycle_id', 'arka_cycles', 'is_closed'))
    assert 'isLegacyArkaDayGuardError' in read('lib/arka/arkaGuards.js')
    engine = read('lib/arka/arkaEngine.js')
    assert "payload = stripKeys(payload, ['cycle_id', 'applied_cycle_id'])" in engine
    assert 'isLegacyArkaDayGuardError(error)' in engine


def main() -> None:
    write('lib/arka/payrollAdvance.js', PAYROLL_ADVANCE_MODULE)
    patch_payroll()
    patch_guards()
    patch_engine()
    write('components/ArkaDailyCloseShortcut.jsx', 'export default function ArkaDailyCloseShortcut() { return null; }\n')
    if (ROOT / 'app/arka/ditore/page.jsx').exists():
        write('app/arka/ditore/page.jsx', RETIRED_DAILY_PAGE)
    verify()
    write(
        'ARKA_OPEN_CLOSE_RETIRED.md',
        '# ARKA open/close retired\n\n'
        '- Payroll advances use a cycle-free writer.\n'
        '- New active pending records strip `cycle_id` and `applied_cycle_id`.\n'
        '- Legacy closed-day errors enter the compatibility fallback path.\n'
        '- The daily-close shortcut is disabled.\n'
        '- Historical records and migrations stay intact for audit history.\n',
    )


if __name__ == '__main__':
    main()
