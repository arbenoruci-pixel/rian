export const BUJAR_CANONICAL_USER_ID = '19d3ab97-2067-493a-aeb1-8a23572dc5f8';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CACHE_PREFIX = 'tepiha_ready_bonus_attention_v4_canonical_user:';

export function canonicalBonusUserId(value) {
  const userId = String(value ?? '').trim().toLowerCase();
  return UUID_RE.test(userId) ? userId : '';
}

export function resolveReadyBonusViewerUserId(payload, actor = null) {
  const rpcViewerUserId = canonicalBonusUserId(
    payload?.viewer?.user_id
      || payload?.viewer?.id
      || payload?.viewer_user_id,
  );
  if (rpcViewerUserId) return rpcViewerUserId;

  return canonicalBonusUserId(actor?.user_id || actor?.id);
}

export function isBujarBonusViewer(userId) {
  return canonicalBonusUserId(userId) === BUJAR_CANONICAL_USER_ID;
}

export function readyBonusCacheKeyForUserId(userId) {
  const canonicalUserId = canonicalBonusUserId(userId);
  return canonicalUserId ? `${CACHE_PREFIX}${canonicalUserId}` : '';
}
