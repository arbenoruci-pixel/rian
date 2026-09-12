export function isReadyNotificationOrderId(value) {
  return /^[1-9][0-9]*$/.test(String(value || '')) && Number.isSafeInteger(Number(value));
}

export function notificationSummary(events = []) {
  const attempts = new Map();
  for (const event of events) {
    const previous = attempts.get(event.attempt_id);
    const rank = { opened: 0, confirmed: 1, cancelled: 2 };
    if (!previous || Date.parse(event.occurred_at) > Date.parse(previous.occurred_at)
      || (Date.parse(event.occurred_at) === Date.parse(previous.occurred_at) && rank[event.kind] > rank[previous.kind])) attempts.set(event.attempt_id, event);
  }
  const latest = [...attempts.values()].sort((a,b) => Date.parse(b.occurred_at)-Date.parse(a.occurred_at));
  return latest.find(e => e.kind === 'confirmed') || latest[0] || null;
}
export function mergeNotificationEvents(current, incoming) {
  const rows = new Map(current.map(e => [e.id,e]));
  for (const event of incoming) rows.set(event.id,event);
  return [...rows.values()];
}
