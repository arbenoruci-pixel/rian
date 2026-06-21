import { getActor } from './actorSession';

function isBrowser() {
  return typeof window !== 'undefined';
}

async function validatePinOnline(pin) {
  const res = await fetch('/api/auth/validate-pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP_${res.status}` };
  return { ok: true, user: json.user || { pin } };
}

// Kthen {pin, name, role} ose null
export async function requirePaymentPin({ label = 'JEP PIN PËR TË KRYER PAGESËN' } = {}) {
  if (!isBrowser()) return null;

  const actor = getActor();

  // 🔥 MAGJIA E ARKËS: A është kjo pajisje e "Bazës"?
  const isBaseTerminal = window.localStorage.getItem('TEPIHA_BASE_TERMINAL') === '1';
  const online = typeof navigator !== 'undefined' ? navigator.onLine : true;

  // NËSE NUK ËSHTË BAZA (psh. telefoni i shoferit), normalisht e marrim PIN-in nga login-i.
  // Por nëse session/localStorage mungon, MOS kthe { pin: undefined }, sepse ARKA dështon
  // me ACTOR_PIN_REQUIRED dhe UI duket sikur pagesa "nuk hyn". Në atë rast kërko PIN.
  if (!isBaseTerminal) {
    const actorPin = String(actor?.pin || '').trim();
    if (actorPin) return { pin: actorPin, name: actor?.name || null, role: actor?.role || null };

    if (!online) {
      window.alert('NUK U GJET PIN I LOGIMIT. HYR PRAPË NË APP OSE KTHEHU ONLINE PËR VERIFIKIM.');
      return null;
    }

    const fallbackEntered = window.prompt(`${label}\n\nNUK U GJET PIN I LOGIMIT NË KËTË PAJISJE. SHKRUAJE PIN-IN:`, '');
    if (fallbackEntered == null) return null;
    const fallbackPin = String(fallbackEntered).trim();
    if (!fallbackPin) return null;

    const fallbackValidation = await validatePinOnline(fallbackPin);
    if (!fallbackValidation.ok) {
      window.alert(`PIN GABIM OSE JO AKTIV. ${fallbackValidation.error ? `(${fallbackValidation.error})` : ''}`);
      return null;
    }
    return {
      pin: String(fallbackValidation.user?.pin || fallbackPin),
      name: fallbackValidation.user?.name || null,
      role: fallbackValidation.user?.role || null,
    };
  }

  // NËSE ËSHTË IPAD-I I BAZËS: Kërkojmë PIN patjetër!
  const entered = window.prompt(label, '');
  if (entered == null) return null; // Anuloi
  const pin = String(entered).trim();
  if (!pin) return null;

  if (!online) {
    // Kur s'ka internet në iPad, lejon vetëm PIN-in e atij që është i loguar aktualisht
    if (actor?.pin && String(actor.pin) === pin) {
      return { pin, name: actor?.name || null, role: actor?.role || null };
    }
    window.alert('OFFLINE: PËR PAGESË DUHET PIN I LOGIMIT.');
    return null;
  }

  // Verifikimi Online në Databazë
  const v = await validatePinOnline(pin);
  if (!v.ok) {
    window.alert('PIN GABIM OSE JO AKTIV.');
    return null;
  }
  return { pin: String(v.user?.pin || pin), name: v.user?.name || null, role: v.user?.role || null };
}
