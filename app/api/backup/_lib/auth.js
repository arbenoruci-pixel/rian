import { NextResponse } from 'next/server';

function readExpectedPin() {
  return String(
    process.env.BACKUP_PIN ||
    process.env.BACKUP_COMPANY_PIN ||
    process.env.ADMIN_PIN ||
    process.env.TEPIHA_RESET_PIN ||
    ''
  ).trim();
}

function readProvidedPin(reqUrl, req) {
  const fromQuery = String(reqUrl.searchParams.get('pin') || '').trim();
  const fromHeader = String(
    req?.headers?.get?.('x-backup-pin') ||
    req?.headers?.get?.('x-admin-pin') ||
    ''
  ).trim();
  return fromQuery || fromHeader;
}

function readCronSecret(req) {
  const auth = String(req?.headers?.get?.('authorization') || '').trim();
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const xCron = String(req?.headers?.get?.('x-cron-secret') || '').trim();
  return xCron || bearer;
}

export function requireBackupPin(req, { allowCron = false } = {}) {
  const reqUrl = new URL(req.url);
  const expectedPin = readExpectedPin();

  if (!expectedPin) {
    return { ok: false, status: 500, error: 'BACKUP_PIN_NOT_SET' };
  }

  if (allowCron) {
    const expectedCron = String(process.env.CRON_SECRET || '').trim();
    const providedCron = readCronSecret(req);
    if (expectedCron && providedCron && providedCron === expectedCron) {
      return { ok: true, via: 'cron' };
    }
  }

  const pin = readProvidedPin(reqUrl, req);
  if (!pin) {
    return { ok: false, status: 401, error: 'PIN_REQUIRED' };
  }
  if (pin !== expectedPin) {
    return { ok: false, status: 401, error: 'INVALID_PIN' };
  }
  return { ok: true, via: 'pin', pin };
}

export function backupUnauthorized(result) {
  return NextResponse.json(
    { ok: false, error: result?.error || 'UNAUTHORIZED' },
    { status: result?.status || 401 }
  );
}
