function cleanCode(value) {
  try { return String(value ?? '').trim(); } catch { return ''; }
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundFontSize(value) {
  return Number(value.toFixed(2));
}

export function getOrderCodeBadgeStyle(code, options = {}) {
  const value = cleanCode(code) || '—';
  const minWidth = Math.max(36, finiteNumber(options.minWidth, 44));
  const maxWidth = Math.max(minWidth, finiteNumber(options.maxWidth, 76));
  const height = Math.max(32, finiteNumber(options.height, 40));
  const maxFontSize = Math.max(10, finiteNumber(options.fontSize, 14));
  const minFontSize = Math.min(maxFontSize, Math.max(7, finiteNumber(options.minFontSize, 8)));
  // iOS renders the heavy system font wider than a simple 7px/character estimate.
  // Keep real inner padding and start shrinking as soon as the code reaches
  // five characters (for example T1089), before either edge gets clipped.
  const desiredWidth = 20 + (value.length * 9.4);
  const width = Math.min(maxWidth, Math.max(minWidth, Math.ceil(desiredWidth)));
  const longCodeChars = Math.max(0, value.length - 4);
  const fontSize = roundFontSize(Math.max(minFontSize, maxFontSize - (longCodeChars * 2)));

  return {
    width,
    minWidth,
    maxWidth,
    height,
    padding: '0 8px',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'clip',
    lineHeight: 1,
    fontSize,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: value.length >= 5 ? '-0.35px' : '-0.1px',
    textAlign: 'center',
  };
}

export function getOrderCodeCircleStyle(code, options = {}) {
  const value = cleanCode(code) || 'T—';
  const diameter = Math.max(28, finiteNumber(options.diameter, 36));
  const horizontalPadding = Math.max(2, finiteNumber(options.horizontalPadding, diameter >= 44 ? 4 : 3));
  const maxFontSize = Math.max(8, finiteNumber(options.fontSize, diameter >= 44 ? 14 : 12));
  const minFontSize = Math.min(maxFontSize, Math.max(5, finiteNumber(options.minFontSize, 6)));

  // Reserve two extra pixels and a 6% glyph-width margin because the
  // 900/1000-weight iOS font is wider than desktop fonts. The weighted
  // estimate gives T and digits their relative width instead of treating
  // every character equally.
  const glyphUnits = Array.from(value).reduce((total, char) => {
    if (/[TWM#]/i.test(char)) return total + 0.7;
    if (/[1I]/.test(char)) return total + 0.56;
    if (/\d/.test(char)) return total + 0.64;
    return total + 0.68;
  }, 0);
  const availableTextWidth = Math.max(1, diameter - (horizontalPadding * 2) - 2);
  const fittedFontSize = availableTextWidth / Math.max(1, glyphUnits * 1.06);
  const fontSize = roundFontSize(Math.max(minFontSize, Math.min(maxFontSize, fittedFontSize)));

  return {
    width: diameter,
    minWidth: diameter,
    maxWidth: diameter,
    height: diameter,
    padding: `0 ${horizontalPadding}px`,
    boxSizing: 'border-box',
    flexShrink: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'clip',
    lineHeight: 1,
    fontSize,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: value.length >= 5 ? '-0.35px' : value.length === 4 ? '-0.15px' : '0px',
    textAlign: 'center',
  };
}
