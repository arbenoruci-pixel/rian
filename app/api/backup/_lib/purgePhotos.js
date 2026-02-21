/**
 * Purge photos from Supabase Storage for orders that are already picked up.
 *
 * Policy:
 * - When an order is marked as "dorzim" it should have `picked_up_at` set.
 * - After N days from `picked_up_at`, we remove files under: photos/<order_id>/
 * - We then stamp `photos_purged_at` so we never purge twice.
 */

export async function purgeOldPhotos(sb, opts = {}) {
  const bucket = opts.bucket || 'tepiha-photos';
  const daysAfterPickup = Number.isFinite(opts.daysAfterPickup) ? Number(opts.daysAfterPickup) : 3;
  const maxOrders = Number.isFinite(opts.maxOrders) ? Number(opts.maxOrders) : 200;

  // Select eligible orders
  const { data: orders, error } = await sb
    .from('orders')
    .select('id, code, picked_up_at, photos_purged_at')
    .eq('status', 'dorzim')
    .not('picked_up_at', 'is', null)
    .is('photos_purged_at', null)
    .lt('picked_up_at', new Date(Date.now() - daysAfterPickup * 24 * 60 * 60 * 1000).toISOString())
    .order('picked_up_at', { ascending: true })
    .limit(maxOrders);

  if (error) return { ok: false, step: 'select', detail: error.message };
  if (!orders || orders.length === 0) return { ok: true, purgedOrders: 0, purgedFiles: 0 };

  let purgedOrders = 0;
  let purgedFiles = 0;
  const failed = [];

  for (const o of orders) {
    const prefix = `photos/${o.id}`;
    try {
      // List files under folder
      const { data: files, error: listErr } = await sb.storage.from(bucket).list(prefix, { limit: 1000 });
      if (listErr) throw new Error(listErr.message);

      const toRemove = (files || [])
        .filter((f) => f && f.name)
        .map((f) => `${prefix}/${f.name}`);

      if (toRemove.length > 0) {
        const { error: rmErr } = await sb.storage.from(bucket).remove(toRemove);
        if (rmErr) throw new Error(rmErr.message);
        purgedFiles += toRemove.length;
      }

      // Mark as purged (even if there were zero files; this avoids repeated scans)
      const { error: upErr } = await sb
        .from('orders')
        .update({ photos_purged_at: new Date().toISOString() })
        .eq('id', o.id);
      if (upErr) throw new Error(upErr.message);

      purgedOrders += 1;
    } catch (e) {
      failed.push({ id: o.id, code: o.code, error: e?.message || String(e) });
    }
  }

  return { ok: failed.length === 0, purgedOrders, purgedFiles, failed };
}
