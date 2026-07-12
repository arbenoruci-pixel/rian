const TRANSPORT_COUNTRY_CODES = Object.freeze(['383', '389', '355', '49', '43', '41']);
const MIN_IMPLICIT_INTERNATIONAL_LOCAL_DIGITS = 8;

export function onlyTransportPhoneDigits(value) {
  return String(value ?? '').replace(/\D+/g, '');
}

function detectTransportCountryCode(candidate, { explicitInternational = false } = {}) {
  for (const countryCode of TRANSPORT_COUNTRY_CODES) {
    if (!candidate.startsWith(countryCode)) continue;
    const localDigits = candidate.slice(countryCode.length);
    if (explicitInternational || localDigits.length >= MIN_IMPLICIT_INTERNATIONAL_LOCAL_DIGITS) {
      return countryCode;
    }
  }
  return '';
}

/**
 * Builds a stable phone identity while preserving the existing Kosovo key format.
 *
 * Kosovo:
 *   +383 45 255 074, 00383 045 255 074 and 045 255 074 -> 45255074
 *
 * Other supported countries keep their country code in the identity key so a
 * Swiss/German/Albanian number cannot collide with a Kosovo local number:
 *   +355 68 123 4567 and 00355 068 123 4567 -> 355681234567
 */
export function parseTransportPhoneIdentity(value) {
  const source = String(value ?? '').trim();
  const rawDigits = onlyTransportPhoneDigits(source);
  const hasPlusPrefix = /^\s*\+/.test(source);
  const hasInternationalDialPrefix = rawDigits.startsWith('00');
  const explicitInternational = hasPlusPrefix || hasInternationalDialPrefix;
  const candidate = hasInternationalDialPrefix ? rawDigits.slice(2) : rawDigits;
  const countryCode = detectTransportCountryCode(candidate, { explicitInternational });

  if (countryCode) {
    const localDigits = candidate.slice(countryCode.length).replace(/^0+/, '');
    const key = countryCode === '383' ? localDigits : `${countryCode}${localDigits}`;
    return {
      key,
      countryCode,
      localDigits,
      rawDigits,
      explicitInternational,
      canonicalDigits: localDigits ? `${countryCode}${localDigits}` : countryCode,
    };
  }

  const localDigits = rawDigits.replace(/^0+/, '');
  return {
    key: localDigits,
    countryCode: '383',
    localDigits,
    rawDigits,
    explicitInternational: false,
    canonicalDigits: localDigits ? `383${localDigits}` : '',
  };
}

export function normalizeTransportPhoneKey(value) {
  return parseTransportPhoneIdentity(value).key;
}

export function isValidTransportPhoneDigits(value) {
  return normalizeTransportPhoneKey(value).length >= 8;
}

export function transportPhoneDigitVariants(value) {
  const identity = parseTransportPhoneIdentity(value);
  const { key, countryCode, localDigits, rawDigits } = identity;
  const variants = new Set();

  if (rawDigits) variants.add(rawDigits);
  if (!key || !localDigits) return Array.from(variants).filter(Boolean);

  if (countryCode === '383') {
    variants.add(key);
    variants.add(`0${key}`);
    variants.add(`383${key}`);
    variants.add(`3830${key}`);
    variants.add(`00383${key}`);
    variants.add(`003830${key}`);
  } else {
    const canonical = `${countryCode}${localDigits}`;
    variants.add(canonical);
    variants.add(`00${canonical}`);
    // Some historical entries kept the domestic trunk zero after the country code.
    variants.add(`${countryCode}0${localDigits}`);
    variants.add(`00${countryCode}0${localDigits}`);
  }

  return Array.from(variants).filter(Boolean);
}

export function sameTransportPhoneDigits(a, b) {
  const aa = normalizeTransportPhoneKey(a);
  const bb = normalizeTransportPhoneKey(b);
  return isValidTransportPhoneDigits(aa) && isValidTransportPhoneDigits(bb) && aa === bb;
}

export const SUPPORTED_TRANSPORT_COUNTRY_CODES = TRANSPORT_COUNTRY_CODES;
