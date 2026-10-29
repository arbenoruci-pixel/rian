import { createHash } from 'node:crypto';
import { BUJAR_USER_ID, BONUS_EVIDENCE_BUCKET, BONUS_EVIDENCE_MAX_BYTES, BONUS_SHELVES, canReviewBonusEvidence, isBujar } from './baseBonusEvidence.js';

export class BonusEvidenceError extends Error {
  constructor(code, httpStatus = 400) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
const fail = (code, status) => { throw new BonusEvidenceError(code, status); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isOrderId = value => /^[1-9]\d{0,14}$/.test(String(value || ''));
const PUBLIC_FIELDS = 'id,order_id,worker_id,status,shelf,created_at,original_deadline,extended_deadline,submitted_at,reviewed_at,reviewed_by,review_note,collected_at,files_deleted_at';

export async function authenticateBonusEvidenceActor(supabase, deviceId) {
  if (!deviceId || deviceId.length > 120) fail('AUTH_REQUIRED', 401);
  const { data: device, error: de } = await supabase.from('tepiha_user_devices').select('user_id,is_approved').eq('device_id', deviceId).maybeSingle();
  if (de) fail('AUTH_DEVICE_LOOKUP_FAILED', 503);
  if (!device?.user_id || device.is_approved !== true) fail('DEVICE_NOT_APPROVED', 403);
  const { data: user, error: ue } = await supabase.from('users').select('id,name,role,is_active').eq('id', device.user_id).maybeSingle();
  if (ue) fail('AUTH_USER_LOOKUP_FAILED', 503);
  if (!user?.id || user.is_active !== true || (!isBujar(user) && !canReviewBonusEvidence(user))) fail('BONUS_EVIDENCE_FORBIDDEN', 403);
  return user;
}

async function rpc(supabase, name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) fail(/^BONUS_EVIDENCE_[A-Z_]+$/.test(error.message || '') ? error.message : 'BONUS_EVIDENCE_SAVE_FAILED', 409);
  if (!data) fail('BONUS_EVIDENCE_SAVE_FAILED', 503);
  return data;
}

async function requestRow(supabase, id) {
  if (!uuid.test(id || '')) fail('BONUS_EVIDENCE_REQUEST_INVALID');
  const { data, error } = await supabase.from('base_bonus_extensions').select('*').eq('id', id).maybeSingle();
  if (error) fail('BONUS_EVIDENCE_READ_FAILED', 503);
  if (!data) fail('BONUS_EVIDENCE_NOT_FOUND', 404);
  return data;
}

async function inspectImage(supabase, path) {
  const { data, error } = await supabase.storage.from(BONUS_EVIDENCE_BUCKET).download(path);
  if (error || !data) fail('BONUS_EVIDENCE_TWO_PHOTOS_REQUIRED');
  if (data.size < 100 || data.size > BONUS_EVIDENCE_MAX_BYTES) fail('BONUS_EVIDENCE_IMAGE_SIZE');
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail('BONUS_EVIDENCE_IMAGE_INVALID');
  return createHash('sha256').update(bytes).digest('hex');
}

export async function bonusEvidenceAction(body, { supabase, actor } = {}) {
  if (!actor?.id || actor.is_active === false || (!isBujar(actor) && !canReviewBonusEvidence(actor))) fail('BONUS_EVIDENCE_FORBIDDEN', 403);
  if (body.expectedActorId !== actor.id) fail('BONUS_EVIDENCE_SESSION_CHANGED', 403);
  const action = body.action;
  if (action === 'LIST') {
    const { data: recent, error } = await supabase.from('base_bonus_extensions').select(PUBLIC_FIELDS).order('created_at', { ascending: false }).limit(200);
    if (error) fail('BONUS_EVIDENCE_READ_FAILED', 503);
    const { data: active, error: ae } = await supabase.from('base_bonus_extensions').select(PUBLIC_FIELDS).in('status', ['DRAFT','PENDING']).order('created_at').limit(1000);
    if (ae) fail('BONUS_EVIDENCE_READ_FAILED', 503);
    const requests = [...new Map([...(active || []), ...(recent || [])].map(r => [r.id,r])).values()];
    const { data: candidates, error: oe } = await supabase.from('orders').select('id,code,client_name,status,created_at,ready_at,data,m2_total').eq('status', 'gati').gte('created_at', new Date(Date.now() - 72 * 3600000).toISOString()).order('created_at').limit(300);
    if (oe) fail('BONUS_EVIDENCE_READ_FAILED', 503);
    // Match PREPARE's earned-bonus guard before offering the four-step wizard.
    // Match by visit/order ID: a reused client code can have a new unpaid visit.
    let earnedBonuses = [];
    if (candidates?.length) {
      const earned = await supabase.from('base_ready_bonuses').select('order_id,amount,status').in('order_id', candidates.map(o => o.id)).eq('eligible', true);
      if (earned.error) fail('BONUS_EVIDENCE_READ_FAILED', 503);
      earnedBonuses = earned.data || [];
    }
    const earnedByOrder = new Map(earnedBonuses.map(b => [String(b.order_id), b]));
    const available = (candidates || []).filter(o => !earnedByOrder.has(String(o.id)));
    const earnedOrders = (candidates || []).filter(o => earnedByOrder.has(String(o.id))).map(o => ({ id: o.id, code: o.code, client_name: o.client_name, amount: Number(earnedByOrder.get(String(o.id)).amount || 0) }));
    const ids = [...new Set((requests || []).map(r => r.order_id))];
    let requestOrders = [];
    if (ids.length) {
      const result = await supabase.from('orders').select('id,code,client_name,status,created_at').in('id', ids);
      if (result.error) fail('BONUS_EVIDENCE_READ_FAILED', 503);
      requestOrders = result.data || [];
    }
    return { actorId: actor.id, manager: canReviewBonusEvidence(actor), serverNow: new Date().toISOString(), requests: (requests || []).map(r => ({ ...r, order: requestOrders.find(o => o.id === r.order_id) || null })), earnedOrders, candidates: available.map(o => ({ id: o.id, code: o.code, client_name: o.client_name, created_at: o.created_at, shelf: o.data?.ready_location || '', deadline: new Date(Date.parse(o.created_at) + 72 * 3600000).toISOString() })) };
  }
  if (action === 'PREPARE') {
    if (!isBujar(actor)) fail('BONUS_EVIDENCE_BUJAR_ONLY', 403);
    if (!isOrderId(body.orderId) || !BONUS_SHELVES.includes(body.shelf)) fail('BONUS_EVIDENCE_SHELF_REQUIRED');
    const request = await rpc(supabase, 'bujar_bonus_evidence_prepare_v1', { p_order_id: body.orderId, p_actor_id: actor.id, p_shelf: body.shelf });
    if (request.status !== 'DRAFT') return { request, uploads: [] };
    const uploads = [];
    for (const [kind, path] of [['carpet', request.carpet_path], ['message', request.message_path]]) {
      // Never overwrite an uploaded object: the signed capability cannot alter submitted evidence.
      const existing = await supabase.storage.from(BONUS_EVIDENCE_BUCKET).info(path);
      if (!existing.error && existing.data) { uploads.push({ kind, path, exists: true, hash: await inspectImage(supabase, path) }); continue; }
      const { data, error } = await supabase.storage.from(BONUS_EVIDENCE_BUCKET).createSignedUploadUrl(path, { upsert: false });
      if (error || !data?.token) fail('BONUS_EVIDENCE_UPLOAD_UNAVAILABLE', 503);
      uploads.push({ kind, path, token: data.token });
    }
    return { request, uploads };
  }
  if (action === 'SUBMIT') {
    if (!isBujar(actor)) fail('BONUS_EVIDENCE_BUJAR_ONLY', 403);
    const row = await requestRow(supabase, body.requestId);
    if (row.worker_id !== actor.id) fail('BONUS_EVIDENCE_FORBIDDEN', 403);
    if (row.status !== 'DRAFT') return { request: await rpc(supabase, 'bujar_bonus_evidence_submit_v1', { p_request_id: row.id, p_actor_id: actor.id, p_carpet_hash: '', p_message_hash: '' }) };
    const [carpetHash, messageHash] = await Promise.all([inspectImage(supabase, row.carpet_path), inspectImage(supabase, row.message_path)]);
    if (carpetHash === messageHash) fail('BONUS_EVIDENCE_DIFFERENT_PHOTOS_REQUIRED');
    return { request: await rpc(supabase, 'bujar_bonus_evidence_submit_v1', { p_request_id: row.id, p_actor_id: actor.id, p_carpet_hash: carpetHash, p_message_hash: messageHash }) };
  }
  if (action === 'VIEW') {
    const row = await requestRow(supabase, body.requestId);
    if (!canReviewBonusEvidence(actor) && row.worker_id !== actor.id) fail('BONUS_EVIDENCE_FORBIDDEN', 403);
    if (row.files_deleted_at) return { images: [], deleted: true };
    const images = [];
    for (const [kind, path] of [['carpet', row.carpet_path], ['message', row.message_path]]) {
      if (row.status === 'DRAFT') {
        const existing = await supabase.storage.from(BONUS_EVIDENCE_BUCKET).info(path);
        if (existing.error || !existing.data) continue;
      }
      const { data, error } = await supabase.storage.from(BONUS_EVIDENCE_BUCKET).createSignedUrl(path, 300);
      if (error || !data?.signedUrl) fail('BONUS_EVIDENCE_PREVIEW_FAILED', 503);
      images.push({ kind, url: data.signedUrl });
    }
    return { images };
  }
  if (action === 'REVIEW') {
    if (!canReviewBonusEvidence(actor) || isBujar(actor)) fail('BONUS_EVIDENCE_REVIEW_FORBIDDEN', 403);
    if (!['APPROVED', 'REJECTED'].includes(body.decision)) fail('BONUS_EVIDENCE_DECISION_REQUIRED');
    const row = await requestRow(supabase, body.requestId);
    if (body.decision === 'APPROVED') {
      if (body.checkedCarpet !== true || body.checkedMessage !== true) fail('BONUS_EVIDENCE_REVIEW_CHECKS_REQUIRED');
      if (row.status === 'PENDING') {
        const [ch, mh] = await Promise.all([inspectImage(supabase, row.carpet_path), inspectImage(supabase, row.message_path)]);
        if (ch !== row.carpet_hash || mh !== row.message_hash) fail('BONUS_EVIDENCE_FILES_CHANGED', 409);
      }
    }
    const request = await rpc(supabase, 'bujar_bonus_evidence_review_v1', { p_request_id: row.id, p_actor_id: actor.id, p_decision: body.decision, p_note: String(body.note || '').trim() });
    // Failure to remove media must not undo an already committed review. Cron retries.
    let cleanupPending = false;
    try { cleanupPending = (await cleanupBonusEvidence(supabase, { requestId: row.id })).failed > 0; } catch { cleanupPending = true; }
    return { request, cleanupPending };
  }
  if (action === 'CLEANUP') {
    if (!isOrderId(body.orderId)) fail('BONUS_EVIDENCE_ORDER_INVALID');
    return cleanupBonusEvidence(supabase, { orderId: body.orderId });
  }
  fail('BONUS_EVIDENCE_ACTION_INVALID');
}

export async function cleanupBonusEvidence(supabase, { requestId = null, orderId = null } = {}) {
  const items = await rpc(supabase, 'bujar_bonus_evidence_cleanup_list_v1', { p_request_id: requestId, p_order_id: orderId });
  let deleted = 0, failed = 0;
  for (const item of items) {
    const paths = [item.carpet_path, item.message_path];
    if (paths[0] !== `${BUJAR_USER_ID}/${item.id}/carpet.jpg` || paths[1] !== `${BUJAR_USER_ID}/${item.id}/message.jpg`) { failed++; continue; }
    const { error } = await supabase.storage.from(BONUS_EVIDENCE_BUCKET).remove(paths);
    if (error) { failed++; continue; }
    await rpc(supabase, 'bujar_bonus_evidence_cleanup_done_v1', { p_request_id: item.id });
    deleted++;
  }
  return { deleted, failed };
}
