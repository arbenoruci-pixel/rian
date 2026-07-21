import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const VERSION = '0.2.0';

function write(relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function replaceRequired(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  if (!source.includes(oldValue)) throw new Error(`Scanner Lite patch target missing: ${label}`);
  return source.replace(oldValue, newValue);
}

write('lib/scanner/liteEngine.js', `const CORNER_NAMES = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function median(values = []) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function percentile(values = [], ratio = 0.8) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.min(ordered.length - 1, Math.round((ordered.length - 1) * ratio)))];
}

function sampleCanvas(source, maxSide = 360) {
  const width = Math.max(1, Number(source?.width || source?.videoWidth || 1));
  const height = Math.max(1, Number(source?.height || source?.videoHeight || 1));
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, context, scale };
}

function grayscale(imageData) {
  const pixels = imageData.data;
  const gray = new Float32Array(imageData.width * imageData.height);
  for (let source = 0, target = 0; source < pixels.length; source += 4, target += 1) {
    gray[target] = (pixels[source] * 0.299) + (pixels[source + 1] * 0.587) + (pixels[source + 2] * 0.114);
  }
  return gray;
}

function boundsFromBrightPaper(gray, width, height) {
  const border = [];
  const borderSize = Math.max(2, Math.round(Math.min(width, height) * 0.025));
  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 80))) {
    for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 80))) {
      if (x < borderSize || x >= width - borderSize || y < borderSize || y >= height - borderSize) {
        border.push(gray[(y * width) + x]);
      }
    }
  }
  const background = median(border);
  const threshold = Math.max(105, Math.min(232, background + 18));
  const rowCounts = new Uint32Array(height);
  const columnCounts = new Uint32Array(width);
  for (let y = 0; y < height; y += 1) {
    const offset = y * width;
    for (let x = 0; x < width; x += 1) {
      if (gray[offset + x] >= threshold) {
        rowCounts[y] += 1;
        columnCounts[x] += 1;
      }
    }
  }

  const minimumRow = Math.max(8, Math.round(width * 0.2));
  const minimumColumn = Math.max(8, Math.round(height * 0.2));
  const run = 3;
  let top = -1;
  let bottom = -1;
  let left = -1;
  let right = -1;

  for (let y = Math.round(height * 0.03); y < Math.round(height * 0.82); y += 1) {
    let valid = true;
    for (let cursor = 0; cursor < run; cursor += 1) valid = valid && rowCounts[Math.min(height - 1, y + cursor)] >= minimumRow;
    if (valid) { top = y; break; }
  }
  for (let y = Math.round(height * 0.97); y > Math.round(height * 0.18); y -= 1) {
    let valid = true;
    for (let cursor = 0; cursor < run; cursor += 1) valid = valid && rowCounts[Math.max(0, y - cursor)] >= minimumRow;
    if (valid) { bottom = y; break; }
  }
  for (let x = Math.round(width * 0.03); x < Math.round(width * 0.82); x += 1) {
    let valid = true;
    for (let cursor = 0; cursor < run; cursor += 1) valid = valid && columnCounts[Math.min(width - 1, x + cursor)] >= minimumColumn;
    if (valid) { left = x; break; }
  }
  for (let x = Math.round(width * 0.97); x > Math.round(width * 0.18); x -= 1) {
    let valid = true;
    for (let cursor = 0; cursor < run; cursor += 1) valid = valid && columnCounts[Math.max(0, x - cursor)] >= minimumColumn;
    if (valid) { right = x; break; }
  }

  if (top < 0 || bottom < 0 || left < 0 || right < 0) return null;
  if ((right - left) < width * 0.28 || (bottom - top) < height * 0.28) return null;
  return { top, bottom, left, right };
}

function gradients(gray, width, height) {
  const gx = new Float32Array(width * height);
  const gy = new Float32Array(width * height);
  const samples = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = (y * width) + x;
      const a = gray[i - width - 1];
      const b = gray[i - width];
      const c = gray[i - width + 1];
      const d = gray[i - 1];
      const f = gray[i + 1];
      const g = gray[i + width - 1];
      const h = gray[i + width];
      const j = gray[i + width + 1];
      const xValue = (-a + c) + (-2 * d) + (2 * f) + (-g + j);
      const yValue = (-a - (2 * b) - c) + g + (2 * h) + j;
      gx[i] = xValue;
      gy[i] = yValue;
      if ((x + y) % 3 === 0) samples.push(Math.hypot(xValue, yValue));
    }
  }
  return { gx, gy, threshold: Math.max(35, percentile(samples, 0.82)) };
}

function projectionBounds(gx, gy, width, height) {
  const rowScores = new Float64Array(height);
  const columnScores = new Float64Array(width);
  for (let y = 2; y < height - 2; y += 1) {
    for (let x = 2; x < width - 2; x += 2) {
      const i = (y * width) + x;
      rowScores[y] += Math.abs(gy[i]);
      columnScores[x] += Math.abs(gx[i]);
    }
  }
  for (let x = 2; x < width - 2; x += 1) {
    if (columnScores[x] === 0) {
      for (let y = 2; y < height - 2; y += 2) columnScores[x] += Math.abs(gx[(y * width) + x]);
    }
  }
  const best = (values, from, to) => {
    let index = -1;
    let score = -1;
    for (let cursor = Math.max(1, Math.round(from)); cursor <= Math.min(values.length - 2, Math.round(to)); cursor += 1) {
      const smooth = values[cursor - 1] + (2 * values[cursor]) + values[cursor + 1];
      if (smooth > score) { score = smooth; index = cursor; }
    }
    return { index, score };
  };
  const top = best(rowScores, height * 0.04, height * 0.48);
  const bottom = best(rowScores, height * 0.52, height * 0.96);
  const left = best(columnScores, width * 0.04, width * 0.48);
  const right = best(columnScores, width * 0.52, width * 0.96);
  if ([top, bottom, left, right].some(item => item.index < 0 || item.score <= 0)) return null;
  if ((right.index - left.index) < width * 0.28 || (bottom.index - top.index) < height * 0.28) return null;
  return { top: top.index, bottom: bottom.index, left: left.index, right: right.index };
}

function fitYFromX(points = []) {
  if (points.length < 5) return null;
  let weight = 0;
  let xMean = 0;
  let yMean = 0;
  for (const point of points) {
    const w = Math.max(1, point.weight || 1);
    weight += w;
    xMean += point.x * w;
    yMean += point.y * w;
  }
  xMean /= weight;
  yMean /= weight;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const w = Math.max(1, point.weight || 1);
    numerator += w * (point.x - xMean) * (point.y - yMean);
    denominator += w * (point.x - xMean) * (point.x - xMean);
  }
  const slope = denominator > 1e-6 ? numerator / denominator : 0;
  return { slope, intercept: yMean - (slope * xMean) };
}

function fitXFromY(points = []) {
  const swapped = points.map(point => ({ x: point.y, y: point.x, weight: point.weight }));
  return fitYFromX(swapped);
}

function refineHorizontal(gy, width, height, yCenter, left, right, threshold) {
  const points = [];
  const radius = Math.max(5, Math.round(height * 0.045));
  for (let x = Math.max(2, left); x <= Math.min(width - 3, right); x += 2) {
    let bestY = -1;
    let best = 0;
    for (let y = Math.max(2, yCenter - radius); y <= Math.min(height - 3, yCenter + radius); y += 1) {
      const value = Math.abs(gy[(y * width) + x]);
      if (value > best) { best = value; bestY = y; }
    }
    if (bestY >= 0 && best >= threshold) points.push({ x, y: bestY, weight: best });
  }
  return fitYFromX(points);
}

function refineVertical(gx, width, height, xCenter, top, bottom, threshold) {
  const points = [];
  const radius = Math.max(5, Math.round(width * 0.045));
  for (let y = Math.max(2, top); y <= Math.min(height - 3, bottom); y += 2) {
    let bestX = -1;
    let best = 0;
    for (let x = Math.max(2, xCenter - radius); x <= Math.min(width - 3, xCenter + radius); x += 1) {
      const value = Math.abs(gx[(y * width) + x]);
      if (value > best) { best = value; bestX = x; }
    }
    if (bestX >= 0 && best >= threshold) points.push({ x: bestX, y, weight: best });
  }
  return fitXFromY(points);
}

function intersect(horizontal, vertical, fallback) {
  if (!horizontal || !vertical) return fallback;
  const denominator = 1 - (vertical.slope * horizontal.slope);
  if (Math.abs(denominator) < 1e-5) return fallback;
  const x = ((vertical.slope * horizontal.intercept) + vertical.intercept) / denominator;
  return { x, y: (horizontal.slope * x) + horizontal.intercept };
}

function area(corners) {
  const points = CORNER_NAMES.map(name => corners[name]);
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += (current.x * next.y) - (next.x * current.y);
  }
  return Math.abs(total) / 2;
}

function validQuad(corners, width, height) {
  if (!corners || CORNER_NAMES.some(name => !Number.isFinite(corners[name]?.x) || !Number.isFinite(corners[name]?.y))) return false;
  const frameArea = Math.max(1, width * height);
  const coverage = area(corners) / frameArea;
  if (coverage < 0.1 || coverage > 0.98) return false;
  const margin = Math.max(width, height) * 0.08;
  return CORNER_NAMES.every(name => corners[name].x >= -margin && corners[name].x <= width + margin && corners[name].y >= -margin && corners[name].y <= height + margin);
}

export function detectDocumentLite(source) {
  if (!source || typeof document === 'undefined') return null;
  try {
    const { canvas, context, scale } = sampleCanvas(source, 360);
    const width = canvas.width;
    const height = canvas.height;
    if (width < 40 || height < 40) return null;
    const imageData = context.getImageData(0, 0, width, height);
    const gray = grayscale(imageData);
    const { gx, gy, threshold } = gradients(gray, width, height);
    const bounds = boundsFromBrightPaper(gray, width, height) || projectionBounds(gx, gy, width, height);
    if (!bounds) return null;

    const topLine = refineHorizontal(gy, width, height, bounds.top, bounds.left, bounds.right, threshold);
    const bottomLine = refineHorizontal(gy, width, height, bounds.bottom, bounds.left, bounds.right, threshold);
    const leftLine = refineVertical(gx, width, height, bounds.left, bounds.top, bounds.bottom, threshold);
    const rightLine = refineVertical(gx, width, height, bounds.right, bounds.top, bounds.bottom, threshold);

    const sampleCorners = {
      topLeft: intersect(topLine, leftLine, { x: bounds.left, y: bounds.top }),
      topRight: intersect(topLine, rightLine, { x: bounds.right, y: bounds.top }),
      bottomRight: intersect(bottomLine, rightLine, { x: bounds.right, y: bounds.bottom }),
      bottomLeft: intersect(bottomLine, leftLine, { x: bounds.left, y: bounds.bottom }),
    };
    if (!validQuad(sampleCorners, width, height)) return null;
    const inverseScale = 1 / Math.max(scale, 1e-6);
    return Object.fromEntries(CORNER_NAMES.map(name => [name, {
      x: clamp(sampleCorners[name].x * inverseScale, 0, source.width),
      y: clamp(sampleCorners[name].y * inverseScale, 0, source.height),
    }]));
  } catch {
    return null;
  }
}

export function bilinearPoint(corners, u, v) {
  const tl = corners.topLeft;
  const tr = corners.topRight;
  const br = corners.bottomRight;
  const bl = corners.bottomLeft;
  const oneU = 1 - u;
  const oneV = 1 - v;
  return {
    x: (tl.x * oneU * oneV) + (tr.x * u * oneV) + (br.x * u * v) + (bl.x * oneU * v),
    y: (tl.y * oneU * oneV) + (tr.y * u * oneV) + (br.y * u * v) + (bl.y * oneU * v),
  };
}

function cornerShape(raw = {}) {
  return {
    topLeft: raw.topLeft || raw.topLeftCorner,
    topRight: raw.topRight || raw.topRightCorner,
    bottomRight: raw.bottomRight || raw.bottomRightCorner,
    bottomLeft: raw.bottomLeft || raw.bottomLeftCorner,
  };
}

function drawTriangle(context, source, sourcePoints, destinationPoints) {
  const [s0, s1, s2] = sourcePoints;
  const [d0, d1, d2] = destinationPoints;
  const denominator = (s0.x * (s1.y - s2.y)) + (s1.x * (s2.y - s0.y)) + (s2.x * (s0.y - s1.y));
  if (Math.abs(denominator) < 1e-7) return;

  const a = ((d0.x * (s1.y - s2.y)) + (d1.x * (s2.y - s0.y)) + (d2.x * (s0.y - s1.y))) / denominator;
  const c = ((d0.x * (s2.x - s1.x)) + (d1.x * (s0.x - s2.x)) + (d2.x * (s1.x - s0.x))) / denominator;
  const e = ((d0.x * ((s1.x * s2.y) - (s2.x * s1.y))) + (d1.x * ((s2.x * s0.y) - (s0.x * s2.y))) + (d2.x * ((s0.x * s1.y) - (s1.x * s0.y)))) / denominator;
  const b = ((d0.y * (s1.y - s2.y)) + (d1.y * (s2.y - s0.y)) + (d2.y * (s0.y - s1.y))) / denominator;
  const d = ((d0.y * (s2.x - s1.x)) + (d1.y * (s0.x - s2.x)) + (d2.y * (s1.x - s0.x))) / denominator;
  const f = ((d0.y * ((s1.x * s2.y) - (s2.x * s1.y))) + (d1.y * ((s2.x * s0.y) - (s0.x * s2.y))) + (d2.y * ((s0.x * s1.y) - (s1.x * s0.y)))) / denominator;

  context.save();
  context.beginPath();
  context.moveTo(d0.x, d0.y);
  context.lineTo(d1.x, d1.y);
  context.lineTo(d2.x, d2.y);
  context.closePath();
  context.clip();
  context.setTransform(a, b, c, d, e, f);
  context.drawImage(source, 0, 0);
  context.restore();
}

function fallbackCrop(source, corners, outputWidth, outputHeight) {
  const canvas = document.createElement('canvas');
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext('2d', { alpha: false });
  const xs = CORNER_NAMES.map(name => corners[name].x);
  const ys = CORNER_NAMES.map(name => corners[name].y);
  const left = clamp(Math.min(...xs), 0, source.width - 1);
  const top = clamp(Math.min(...ys), 0, source.height - 1);
  const right = clamp(Math.max(...xs), left + 1, source.width);
  const bottom = clamp(Math.max(...ys), top + 1, source.height);
  context.drawImage(source, left, top, right - left, bottom - top, 0, 0, outputWidth, outputHeight);
  return canvas;
}

export function extractPaperLite(source, requestedWidth, requestedHeight, rawCorners) {
  if (!source || typeof document === 'undefined') return null;
  const corners = cornerShape(rawCorners);
  if (!validQuad(corners, source.width, source.height)) return null;
  const width = Math.max(320, Number(requestedWidth || 1200));
  const height = Math.max(320, Number(requestedHeight || 1600));
  const scale = Math.min(1, 1800 / Math.max(width, height));
  const outputWidth = Math.max(320, Math.round(width * scale));
  const outputHeight = Math.max(320, Math.round(height * scale));

  try {
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, outputWidth, outputHeight);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    const columns = 16;
    const rows = 16;
    for (let row = 0; row < rows; row += 1) {
      const v0 = row / rows;
      const v1 = (row + 1) / rows;
      for (let column = 0; column < columns; column += 1) {
        const u0 = column / columns;
        const u1 = (column + 1) / columns;
        const s00 = bilinearPoint(corners, u0, v0);
        const s10 = bilinearPoint(corners, u1, v0);
        const s11 = bilinearPoint(corners, u1, v1);
        const s01 = bilinearPoint(corners, u0, v1);
        const d00 = { x: u0 * outputWidth, y: v0 * outputHeight };
        const d10 = { x: u1 * outputWidth, y: v0 * outputHeight };
        const d11 = { x: u1 * outputWidth, y: v1 * outputHeight };
        const d01 = { x: u0 * outputWidth, y: v1 * outputHeight };
        drawTriangle(context, source, [s00, s10, s11], [d00, d10, d11]);
        drawTriangle(context, source, [s00, s11, s01], [d00, d11, d01]);
      }
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  } catch {
    return fallbackCrop(source, corners, outputWidth, outputHeight);
  }
}

export function createLiteScanner() {
  return {
    mode: 'local-js-lite-0.2',
    detectDocument: detectDocumentLite,
    extractPaper: extractPaperLite,
  };
}
`);

write('lib/scanner/runtime.js', `import { createLiteScanner } from './liteEngine.js';

let runtimePromise = null;

export function loadScannerRuntime(onStage = () => {}) {
  if (runtimePromise) return runtimePromise;
  runtimePromise = Promise.resolve().then(() => {
    onStage('Starting local vision core');
    const scanner = createLiteScanner();
    onStage('Local engine ready');
    return { cv: null, scanner, mode: scanner.mode };
  }).catch(error => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

export async function registerLabServiceWorker() {
  if (typeof window === 'undefined') return null;
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
    }
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.filter(name => /scanner-lab/i.test(name)).map(name => caches.delete(name)));
    }
  } catch {}
  return null;
}
`);

write('lib/scanner/quality.js', `import { clamp, documentCoverage, rectangleScore } from './geometry.js';

function sampleGray(canvas, maxSide = 240) {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const sample = document.createElement('canvas');
  sample.width = Math.max(1, Math.round(canvas.width * scale));
  sample.height = Math.max(1, Math.round(canvas.height * scale));
  const context = sample.getContext('2d', { alpha: false, willReadFrequently: true });
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  const gray = new Float32Array(sample.width * sample.height);
  let brightnessTotal = 0;
  let glareCount = 0;
  for (let source = 0, target = 0; source < pixels.length; source += 4, target += 1) {
    const value = (pixels[source] * 0.299) + (pixels[source + 1] * 0.587) + (pixels[source + 2] * 0.114);
    gray[target] = value;
    brightnessTotal += value;
    if (value >= 247) glareCount += 1;
  }
  return {
    gray,
    width: sample.width,
    height: sample.height,
    brightness: brightnessTotal / Math.max(1, gray.length),
    glareRatio: glareCount / Math.max(1, gray.length),
  };
}

function laplacianVariance(gray, width, height) {
  let count = 0;
  let total = 0;
  let totalSquared = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width) + x;
      const value = (4 * gray[index]) - gray[index - 1] - gray[index + 1] - gray[index - width] - gray[index + width];
      total += value;
      totalSquared += value * value;
      count += 1;
    }
  }
  if (!count) return 0;
  const mean = total / count;
  return Math.max(0, (totalSquared / count) - (mean * mean));
}

export function scoreQuality(metrics = {}) {
  const blur = clamp((Number(metrics.blurVariance || 0) - 28) / 210);
  const brightness = Number(metrics.brightness || 0);
  const exposure = clamp(1 - (Math.abs(brightness - 145) / 125));
  const glare = clamp(1 - (Number(metrics.glareRatio || 0) / 0.085));
  const coverage = clamp((Number(metrics.coverage || 0) - 0.14) / 0.56);
  const shape = clamp(Number(metrics.rectangleScore || 0));
  return clamp((blur * 0.28) + (exposure * 0.18) + (glare * 0.15) + (coverage * 0.24) + (shape * 0.15));
}

export function qualityMessage(metrics = {}) {
  if (!metrics.detected) return 'Find all four document edges';
  if (metrics.coverage < 0.18) return 'Move closer';
  if (metrics.coverage > 0.95) return 'Move back slightly';
  if (metrics.brightness < 58) return 'More light needed';
  if (metrics.brightness > 228) return 'Reduce direct light';
  if (metrics.glareRatio > 0.085) return 'Tilt phone to remove glare';
  if (metrics.blurVariance < 40) return 'Hold still';
  if (metrics.rectangleScore < 0.55) return 'Center the document';
  return 'Hold steady';
}

export function qualityBand(score = 0) {
  if (score >= 0.72) return 'excellent';
  if (score >= 0.56) return 'good';
  if (score >= 0.4) return 'fair';
  return 'poor';
}

export function analyzeFrameQuality(canvas, _cv, corners = null) {
  if (!canvas || typeof document === 'undefined') {
    return { detected: !!corners, score: 0, band: 'poor', message: 'Quality engine unavailable' };
  }
  try {
    const sample = sampleGray(canvas);
    const metrics = {
      detected: !!corners,
      blurVariance: laplacianVariance(sample.gray, sample.width, sample.height),
      brightness: sample.brightness,
      glareRatio: sample.glareRatio,
      coverage: corners ? documentCoverage(corners, canvas.width, canvas.height) : 0,
      rectangleScore: corners ? rectangleScore(corners) : 0,
    };
    const score = scoreQuality(metrics);
    return { ...metrics, score, band: qualityBand(score), message: qualityMessage(metrics) };
  } catch (error) {
    return {
      detected: !!corners,
      score: 0,
      band: 'poor',
      message: corners ? 'Hold steady' : 'Find all four document edges',
      error: error?.message || String(error),
    };
  }
}
`);

let pipeline = read('lib/scanner/pipeline.js');
pipeline = replaceRequired(
  pipeline,
  `export function detectDocument(canvas, cv, scanner) {\n  if (!canvas || !cv || !scanner) return null;\n  let src = null;\n  let contour = null;\n  try {\n    src = cv.imread(canvas);\n    contour = scanner.findPaperContour(src);\n    if (!contour) return null;\n    const found = scanner.getCornerPoints(contour, src);\n    return fromJscanifyCorners(found);\n  } catch {\n    return null;\n  } finally {\n    try { contour?.delete?.(); } catch {}\n    try { src?.delete?.(); } catch {}\n  }\n}`,
  `export function detectDocument(canvas, cv, scanner) {\n  if (!canvas || !scanner) return null;\n  if (typeof scanner.detectDocument === 'function') {\n    try { return scanner.detectDocument(canvas) || null; } catch { return null; }\n  }\n  if (!cv) return null;\n  let src = null;\n  let contour = null;\n  try {\n    src = cv.imread(canvas);\n    contour = scanner.findPaperContour(src);\n    if (!contour) return null;\n    const found = scanner.getCornerPoints(contour, src);\n    return fromJscanifyCorners(found);\n  } catch {\n    return null;\n  } finally {\n    try { contour?.delete?.(); } catch {}\n    try { src?.delete?.(); } catch {}\n  }\n}`,
  'pipeline local detector adapter',
);
write('lib/scanner/pipeline.js', pipeline);

let component = read('components/ScannerLab.jsx');
component = replaceRequired(component, 'const PREVIEW_MAX_SIDE = 780;', 'const PREVIEW_MAX_SIDE = 560;', 'preview analysis size');
component = replaceRequired(component, 'const SOURCE_MAX_SIDE = 3000;', 'const SOURCE_MAX_SIDE = 2200;', 'source memory cap');
component = replaceRequired(component, "useState('Preparing scanner engine')", "useState('Starting local vision core')", 'initial engine stage');
component = replaceRequired(component, "engineReady ? 'Engine ready'", "engineReady ? 'Local engine ready'", 'engine status label');
component = replaceRequired(component, 'SCANNER CORE · DEMO 0.1', 'SCANNER CORE · DEMO 0.2', 'demo label');
component = replaceRequired(component, 'OpenCV contour + normalized quadrilateral', 'Local edge geometry + normalized quadrilateral', 'architecture detector label');
write('components/ScannerLab.jsx', component);

write('public/sw.js', `self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  try {
    const names = await caches.keys();
    await Promise.all(names.map(name => caches.delete(name)));
    await self.registration.unregister();
  } catch {}
  await self.clients.claim();
})()));
`);

write('public/scanner-engine.json', `${JSON.stringify({
  version: VERSION,
  mode: 'local-js-lite',
  externalRuntime: false,
  maxSourceSide: 2200,
  detector: 'edge-projection-plus-bright-paper',
  perspective: 'canvas-bilinear-mesh',
}, null, 2)}\n`);

write('tests/lite-engine.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
import { bilinearPoint } from '../lib/scanner/liteEngine.js';

test('bilinear geometry keeps exact document corners', () => {
  const corners = {
    topLeft:{ x:10, y:20 },
    topRight:{ x:110, y:25 },
    bottomRight:{ x:120, y:225 },
    bottomLeft:{ x:0, y:210 },
  };
  assert.deepEqual(bilinearPoint(corners, 0, 0), corners.topLeft);
  assert.deepEqual(bilinearPoint(corners, 1, 0), corners.topRight);
  assert.deepEqual(bilinearPoint(corners, 1, 1), corners.bottomRight);
  assert.deepEqual(bilinearPoint(corners, 0, 1), corners.bottomLeft);
});

test('bilinear geometry maps the center inside the quadrilateral', () => {
  const center = bilinearPoint({
    topLeft:{ x:0, y:0 },
    topRight:{ x:100, y:0 },
    bottomRight:{ x:120, y:200 },
    bottomLeft:{ x:-20, y:200 },
  }, 0.5, 0.5);
  assert.equal(center.x, 50);
  assert.equal(center.y, 100);
});
`);

const verification = [
  ['lib/scanner/runtime.js', "mode: scanner.mode"],
  ['lib/scanner/runtime.js', "cv: null"],
  ['lib/scanner/liteEngine.js', 'detectDocumentLite'],
  ['lib/scanner/liteEngine.js', 'extractPaperLite'],
  ['lib/scanner/quality.js', 'laplacianVariance'],
  ['lib/scanner/pipeline.js', "typeof scanner.detectDocument === 'function'"],
  ['components/ScannerLab.jsx', 'SCANNER CORE · DEMO 0.2'],
  ['public/scanner-engine.json', 'local-js-lite'],
];
for (const [relative, marker] of verification) {
  if (!read(relative).includes(marker)) throw new Error(`${relative} is missing ${marker}`);
}

console.log('PASS — Scanner Lab 0.2 uses a local iPhone-safe vision core with no external OpenCV runtime.');
