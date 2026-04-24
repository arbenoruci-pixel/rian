import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import logger from '@/lib/logger';
import { parseJsonBodySafe } from '@/lib/validation';

export function apiJson(payload, status = 200) {
  return NextResponse.json(payload, { status });
}

export function apiOk(payload = {}, status = 200) {
  return apiJson({ ok: true, ...payload }, status);
}

export function apiFail(error, status = 400, extra = {}) {
  const payload = typeof error === 'string' ? { error } : { error: String(error?.message || error || 'UNKNOWN_ERROR') };
  return apiJson({ ok: false, ...payload, ...extra }, status);
}

export async function readBody(req) {
  return parseJsonBodySafe(req);
}

export function createServiceClientOrThrow() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !supabaseKey) {
    const err = new Error('SERVER_NOT_CONFIGURED');
    err.code = 'SERVER_NOT_CONFIGURED';
    throw err;
  }
  return createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
}

export function logApiError(scope, error, meta = {}) {
  logger.error(scope, { ...meta, error: String(error?.message || error), code: error?.code || null });
}
