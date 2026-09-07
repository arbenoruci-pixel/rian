import { persistMainSession, readBestActor } from './sessionStore';

const PAYMENT_PIN_VERIFY_TIMEOUT_MS = 6000;

function isBrowser() {
  return typeof window !== 'undefined';
}

function transientPinValidationResult(error, timedOut = false) {
  const code = timedOut || error?.name === 'AbortError'
    ? 'PIN_VERIFY_TIMEOUT'
    : 'PIN_VERIFY_NETWORK_FAILED';
  return { ok: false, error: code, transient: true };
}

async function validatePinOnline(pin, { timeoutMs = PAYMENT_PIN_VERIFY_TIMEOUT_MS } = {}) {
  let controller = null;
  let timer = 0;
  try {
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      timer = window.setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || PAYMENT_PIN_VERIFY_TIMEOUT_MS));
    }
    const res = await fetch('/api/auth/validate-pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      const errorCode = json?.error || `HTTP_${res.status}`;
      const transient = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
      return { ok: false, error: errorCode, transient };
    }
    return { ok: true, user: json.user || { pin }, transient: false };
  } catch (error) {
    return transientPinValidationResult(error);
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

async function validatePinOnlineWithRetry(pin) {
  const first = await validatePinOnline(pin);
  if (first.ok || !first.transient) return first;
  await new Promise((resolve) => window.setTimeout(resolve, 250));
  return validatePinOnline(pin);
}

function actorMatchesEnteredPin(actor, pin) {
  const actorPin = String(actor?.pin || actor?.transport_pin || '').trim();
  return !!actorPin && actorPin === String(pin || '').trim();
}

function normalizedValidatedUser(validation, fallbackPin) {
  return {
    pin: String(validation?.user?.pin || fallbackPin || '').trim(),
    name: validation?.user?.name || null,
    role: validation?.user?.role || null,
  };
}

function showPinNetworkError(error = '') {
  const suffix = error ? ` (${error})` : '';
  window.alert(`LIDHJA PËR VERIFIKIMIN E PIN-IT DËSHTOI${suffix}. PROVO PRAPË OSE HAPE APP-IN PËRSËRI.`);
}

// Kthen {pin, name, role} ose null
export async function requirePaymentPin({ label = 'JEP PIN PËR TË KRYER PAGESËN' } = {}) {
  if (!isBrowser()) return null;

  // Pagesat në telefonin e shoferit duhet ta lexojnë edhe transport session-in.
  // Main session mund të mungojë në PWA edhe pse shoferi është i kyçur saktë.
  const actor = readBestActor({ allowTransportFallback: true });

  // 🔥 MAGJIA E ARKËS: A është kjo pajisje e "Bazës"?
  const isBaseTerminal = window.localStorage.getItem('TEPIHA_BASE_TERMINAL') === '1';
  const online = typeof navigator !== 'undefined' ? navigator.onLine : true;

  // NËSE NUK ËSHTË BAZA (psh. telefoni i punëtorit/shoferit), përdor session-in aktual.
  // Nëse cache i vjetër e ka pastruar session-in, verifiko PIN-in një herë dhe
  // rikrijoje session-in kanonik që pagesat e ardhshme të mos varen nga fetch-i.
  if (!isBaseTerminal) {
    const actorPin = String(actor?.pin || actor?.transport_pin || '').trim();
    if (actorPin) {
      return {
        pin: actorPin,
        name: actor?.name || actor?.transport_name || null,
        role: actor?.role || 'TRANSPORT',
      };
    }

    if (!online) {
      window.alert('NUK U GJET PIN I LOGIMIT. HYR PRAPË NË APP OSE KTHEHU ONLINE PËR VERIFIKIM.');
      return null;
    }

    const fallbackEntered = window.prompt(`${label}\n\nNUK U GJET PIN I LOGIMIT NË KËTË PAJISJE. SHKRUAJE PIN-IN:`, '');
    if (fallbackEntered == null) return null;
    const fallbackPin = String(fallbackEntered).trim();
    if (!fallbackPin) return null;

    const fallbackValidation = await validatePinOnlineWithRetry(fallbackPin);
    if (!fallbackValidation.ok) {
      if (fallbackValidation.transient) showPinNetworkError(fallbackValidation.error);
      else window.alert(`PIN GABIM OSE JO AKTIV. ${fallbackValidation.error ? `(${fallbackValidation.error})` : ''}`);
      return null;
    }

    const recoveredActor = normalizedValidatedUser(fallbackValidation, fallbackPin);
    try {
      persistMainSession(recoveredActor, {
        source: 'PAYMENT_PIN_SESSION_RECOVERY_V1',
        recovered_at: new Date().toISOString(),
      });
    } catch {}
    return recoveredActor;
  }

  // NËSE ËSHTË IPAD-I I BAZËS: Kërkojmë PIN patjetër!
  const entered = window.prompt(label, '');
  if (entered == null) return null;
  const pin = String(entered).trim();
  if (!pin) return null;

  if (!online) {
    if (actorMatchesEnteredPin(actor, pin)) {
      return { pin, name: actor?.name || null, role: actor?.role || null };
    }
    window.alert('OFFLINE: PËR PAGESË DUHET PIN I LOGIMIT.');
    return null;
  }

  const validation = await validatePinOnline(pin);
  if (!validation.ok) {
    // Pajisja e bazës vazhdon të kërkojë PIN çdo herë. Nëse vetëm rrjeti i
    // endpoint-it dështon, një PIN që përputhet saktë me session-in e kyçur
    // lejohet njësoj si në mënyrën offline; PIN tjetër nuk anashkalon serverin.
    if (validation.transient && actorMatchesEnteredPin(actor, pin)) {
      return { pin, name: actor?.name || null, role: actor?.role || null };
    }
    if (validation.transient) showPinNetworkError(validation.error);
    else window.alert('PIN GABIM OSE JO AKTIV.');
    return null;
  }
  return normalizedValidatedUser(validation, pin);
}
