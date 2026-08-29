function cleanCode(value) {
  try { return String(value ?? '').trim(); } catch { return ''; }
}
export function getOrderCodeBadgeStyle(code, options = {}) {
  const value = cleanCode(code) || '—';
  const minWidth = Math.max(36, Number(options.minWidth || 44));
  const maxWidth = Math.max(minWidth, Number(options.maxWidth || 76));
  const height = Math.max(32, Number(options.height || 40));
  const maxFontSize = Math.max(10, Number(options.fontSize || 14));
  const minFontSize = Math.min(maxFontSize, Math.max(9, Number(options.minFontSize || 10)));
  // iOS renders the heavy system font wider than a simple 7px/character estimate.
  // Keep real inner padding around both the leading T and the last digit.
  const desiredWidth = 20 + (value.length * 9.4);
  const width = Math.min(maxWidth, Math.max(minWidth, Math.ceil(desiredWidth)));
  const overflowChars = Math.max(0, value.length - 6);
  const fontSize = Math.max(minFontSize, Number((maxFontSize - overflowChars * 0.9).toFixed(1)));

  return {
    width,
    minWidth,
    maxWidth,
    height,
    padding: '0 7px',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'clip',
    lineHeight: 1,
    fontSize,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: value.length > 6 ? '-0.45px' : '-0.1px',
    textAlign: 'center',
  };
}
