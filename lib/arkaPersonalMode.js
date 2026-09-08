const MANAGERS = new Set(['MASTER', 'DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN']);
export function isPersonalArkaMode(actor = {}, search = '') {
  const raw = String(actor?.role || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const role = ['MASTER_USER', 'MASTERUSER'].includes(raw) ? 'MASTER' : raw;
  return !!String(actor?.pin || '').trim()
    && MANAGERS.has(role)
    && new URLSearchParams(search).get('personal') === '1';
}
