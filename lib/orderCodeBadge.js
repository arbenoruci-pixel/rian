function cleanCode(value) {
  try { return String(value ?? '').trim(); } catch { return ''; }
}
export function getOrderCodeBadgeStyle(code, options = {}) {
  const value = cleanCode(code) || '—';
  const minWidth = Math.max(32, Number(options.minWidth || 40));
  const maxWidth = Math.max(minWidth, Number(options.maxWidth || 72));
  const height = Math.max(32, Number(options.height || 40));
  const maxFontSize = Math.max(10, Number(options.fontSize || 14));
  const minFontSize = Math.min(maxFontSize, Math.max(9, Number(options.minFontSize || 10)));
  const desiredWidth = 14 + (value.length * 7.4);
  const width = Math.min(maxWidth, Math.max(minWidth, Math.ceil(desiredWidth)));
  const overflowChars = Math.max(0, value.length - 6);
  const fontSize = Math.max(minFontSize, Number((maxFontSize - overflowChars * 0.9).toFixed(1)));

  return {
    width,
    minWidth,
    maxWidth,
    height,
    padding: '0 4px',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'clip',
    lineHeight: 1,
    fontSize,
  };
}
