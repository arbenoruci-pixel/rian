// Shared injectable worker core: provider acceptance is not proof of reading.
export async function deliverPushBatch({ rpc, send, config, lease = crypto.randomUUID() }) {
  const jobs = await rpc('transport_push_claim_v1', { p_lease: lease });
  const results = await Promise.all(jobs.map(async job => {
    let status = 0;
    try {
      const payload = {
        version: 1, eventId: job.eventId, userId: job.userId, orderId: job.orderId,
        title: job.kind === 'test' ? 'TEPIHA — Njoftim provë' : 'TEPIHA — Porosi e re',
        body: job.kind === 'test' ? 'Njoftimet janë aktivizuar në këtë telefon.' : 'Dispatch ta ka caktuar një porosi. Preke për ta hapur.',
      };
      const response = await send(job.subscription, JSON.stringify(payload), {
        vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
        TTL: 3600, urgency: 'high', timeout: 8000,
        topic: job.eventId.replace(/-/g, '').slice(0, 32),
      });
      status = response.statusCode;
    } catch (error) { status = Number(error?.statusCode) || 0; }
    await rpc('transport_push_finish_v1', { p_id: job.id, p_lease: lease, p_status: status });
    return status;
  }));
  return { processed: results.length, accepted: results.filter(s => s >= 200 && s < 300).length };
}
