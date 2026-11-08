import { cleanupTransportControlEvidence } from '../../lib/transportControlServer.js';
import { timingSafeEqual } from 'node:crypto';
import { apiFail, apiOk, createAdminClientOrThrow } from '../_helpers.js';
import { cleanupBonusEvidence } from '../../lib/baseBonusEvidenceServer.js';
export const config = { maxDuration: 60 };
export default async function handler(req, res) {
  res.setHeader('cache-control', 'private, no-store');
  if (req.method !== 'GET') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
  const expected = process.env.CRON_SECRET;
  const actual = String(req.headers?.authorization || '');
  if (!expected || actual.length !== `Bearer ${expected}`.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(`Bearer ${expected}`))) return apiFail(res, 'UNAUTHORIZED', 401);
  try { const client=createAdminClientOrThrow(); const result = await cleanupBonusEvidence(client); const transport=await cleanupTransportControlEvidence(client); return apiOk(res, { ...result, transport }, result.failed || transport.failed ? 503 : 200); }
  catch { return apiFail(res, 'BONUS_EVIDENCE_CLEANUP_FAILED', 503); }
}
