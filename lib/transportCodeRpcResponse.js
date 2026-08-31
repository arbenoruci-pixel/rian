function normalizeOneTransportCode(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return '';
    return `T${value}`;
  }

  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!/^t?0*\d+$/i.test(raw)) return '';
  const digits = raw.replace(/^t/i, '').replace(/^0+/, '') || '0';
  return digits === '0' ? '' : `T${digits}`;
}

function collectTransportCodes(value, out, depth = 0) {
  if (value == null || depth > 6) return;

  const direct = normalizeOneTransportCode(value);
  if (direct) {
    out.push(direct);
    return;
  }

  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return;

    // PostgREST normally decodes JSONB. Some cached/bridged responses can still
    // arrive as JSON text (occasionally double encoded), so unwrap them safely.
    if (/^[\[{\"]/.test(raw)) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed !== value) collectTransportCodes(parsed, out, depth + 1);
        return;
      } catch {}
    }

    // Compatibility with a PostgreSQL text[] representation such as {T12,T13}.
    if (/^\{[^{}]*\}$/.test(raw)) {
      raw.slice(1, -1).split(',').forEach((item) => collectTransportCodes(item, out, depth + 1));
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectTransportCodes(item, out, depth + 1));
    return;
  }

  if (typeof value !== 'object') return;

  const codeKeys = ['code_str', 'code', 'code_n', 'transport_code', 'tcode'];
  const wrapperKeys = [
    'codes',
    'reserved_codes',
    'transport_codes',
    'result',
    'data',
    'reserve_transport_codes_batch',
  ];

  for (const key of codeKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    collectTransportCodes(value[key], out, depth + 1);
  }
  for (const key of wrapperKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    collectTransportCodes(value[key], out, depth + 1);
  }

  // Unknown keys stay ignored so metadata such as { status: 500 } cannot be
  // mistaken for T500. The canonical function-name wrapper is listed above.
}

export function normalizeTransportCodeRpcResponse(data) {
  const collected = [];
  collectTransportCodes(data, collected);
  const unique = Array.from(new Set(collected));
  unique.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return unique;
}
