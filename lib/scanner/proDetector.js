const CORNER_NAMES = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];

function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function percentile(values = [], ratio = 0.5) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(ordered.length - 1, Math.round((ordered.length - 1) * ratio)));
  return ordered[index];
}

function polygonArea(corners = {}) {
  const points = CORNER_NAMES.map(name => corners[name]).filter(Boolean);
  if (points.length !== 4) return 0;
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += (current.x * next.y) - (next.x * current.y);
  }
  return Math.abs(total) / 2;
}

function distance(a = {}, b = {}) {
  return Math.hypot(Number(a.x || 0) - Number(b.x || 0), Number(a.y || 0) - Number(b.y || 0));
}

function bilinearPoint(corners, u, v) {
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

function featuresFromImageData(imageData) {
  const width = Math.max(1, Number(imageData?.width || 1));
  const height = Math.max(1, Number(imageData?.height || 1));
  const pixels = imageData?.data || new Uint8ClampedArray(width * height * 4);
  const gray = new Float32Array(width * height);
  const chroma = new Uint8Array(width * height);
  const samples = [];
  const borderGray = [];
  const borderChroma = [];
  const border = Math.max(2, Math.round(Math.min(width, height) * 0.035));
  const sampleStep = Math.max(1, Math.floor(Math.max(width, height) / 180));

  for (let source = 0, target = 0; target < gray.length; source += 4, target += 1) {
    const r = Number(pixels[source] || 0);
    const g = Number(pixels[source + 1] || 0);
    const b = Number(pixels[source + 2] || 0);
    const value = (r * 0.299) + (g * 0.587) + (b * 0.114);
    gray[target] = value;
    chroma[target] = Math.max(r, g, b) - Math.min(r, g, b);
    const x = target % width;
    const y = Math.floor(target / width);
    if ((x % sampleStep === 0) && (y % sampleStep === 0)) samples.push(value);
    if (x < border || x >= width - border || y < border || y >= height - border) {
      if ((x + y) % sampleStep === 0) {
        borderGray.push(value);
        borderChroma.push(chroma[target]);
      }
    }
  }

  return {
    width,
    height,
    gray,
    chroma,
    q35: percentile(samples, 0.35),
    q55: percentile(samples, 0.55),
    q68: percentile(samples, 0.68),
    borderGray: percentile(borderGray, 0.5),
    borderChroma: percentile(borderChroma, 0.5),
  };
}

function buildPaperMask(features, mode = 'balanced') {
  const { width, height, gray, chroma, q35, q55, q68, borderGray } = features;
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    const value = gray[index];
    const color = chroma[index];
    let accepted = false;
    if (mode === 'strict') {
      accepted = value >= Math.max(132, q68) && color <= 92;
    } else if (mode === 'shadow') {
      accepted = value >= Math.max(58, q35 - 8)
        && color <= 46
        && (value >= borderGray - 10 || value >= q55 - 18);
    } else {
      accepted = (
        value >= Math.max(82, borderGray + 7, q55 - 2)
        && color <= 78
      ) || (
        value >= Math.max(150, q68 - 5)
        && color <= 118
      ) || (
        value >= Math.max(72, q35)
        && color <= 38
      );
    }
    mask[index] = accepted ? 1 : 0;
  }
  return mask;
}

function dilate(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width) + x;
      if (
        mask[index]
        || mask[index - 1]
        || mask[index + 1]
        || mask[index - width]
        || mask[index + width]
        || mask[index - width - 1]
        || mask[index - width + 1]
        || mask[index + width - 1]
        || mask[index + width + 1]
      ) out[index] = 1;
    }
  }
  return out;
}

function erode(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width) + x;
      if (
        mask[index]
        && mask[index - 1]
        && mask[index + 1]
        && mask[index - width]
        && mask[index + width]
        && mask[index - width - 1]
        && mask[index - width + 1]
        && mask[index + width - 1]
        && mask[index + width + 1]
      ) out[index] = 1;
    }
  }
  return out;
}

function closeMask(mask, width, height, passes = 1) {
  let current = mask;
  for (let pass = 0; pass < passes; pass += 1) current = erode(dilate(current, width, height), width, height);
  return current;
}

function connectedComponents(mask, width, height) {
  const labels = new Int32Array(mask.length);
  labels.fill(-1);
  const queue = new Int32Array(mask.length);
  const components = [];
  let label = 0;

  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || labels[seed] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    labels[seed] = label;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    let borderHits = 0;

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      area += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumYY += y * y;
      sumXY += x * y;
      if (x <= 1 || y <= 1 || x >= width - 2 || y >= height - 2) borderHits += 1;

      for (let oy = -1; oy <= 1; oy += 1) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        for (let ox = -1; ox <= 1; ox += 1) {
          if (!ox && !oy) continue;
          const nx = x + ox;
          if (nx < 0 || nx >= width) continue;
          const next = (ny * width) + nx;
          if (mask[next] && labels[next] === -1) {
            labels[next] = label;
            queue[tail++] = next;
          }
        }
      }
    }

    components.push({ label, area, minX, maxX, minY, maxY, sumX, sumY, sumXX, sumYY, sumXY, borderHits });
    label += 1;
  }

  return { labels, components };
}

function orientedBox(component, labels, width, height) {
  const area = Math.max(1, component.area);
  const centerX = component.sumX / area;
  const centerY = component.sumY / area;
  const covXX = (component.sumXX / area) - (centerX * centerX);
  const covYY = (component.sumYY / area) - (centerY * centerY);
  const covXY = (component.sumXY / area) - (centerX * centerY);
  const angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const vx = -uy;
  const vy = ux;
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;

  for (let y = component.minY; y <= component.maxY; y += 1) {
    for (let x = component.minX; x <= component.maxX; x += 1) {
      const index = (y * width) + x;
      if (labels[index] !== component.label) continue;
      const dx = x - centerX;
      const dy = y - centerY;
      const u = (dx * ux) + (dy * uy);
      const v = (dx * vx) + (dy * vy);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }

  const point = (u, v) => ({ x: centerX + (u * ux) + (v * vx), y: centerY + (u * uy) + (v * vy) });
  const raw = [point(minU, minV), point(maxU, minV), point(maxU, maxV), point(minU, maxV)];
  return orderCorners(raw);
}

function diagonalBox(component, labels, width) {
  let topLeft = null;
  let topRight = null;
  let bottomRight = null;
  let bottomLeft = null;
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDiff = Infinity;
  let maxDiff = -Infinity;

  for (let y = component.minY; y <= component.maxY; y += 1) {
    for (let x = component.minX; x <= component.maxX; x += 1) {
      const index = (y * width) + x;
      if (labels[index] !== component.label) continue;
      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) { minSum = sum; topLeft = { x, y }; }
      if (sum > maxSum) { maxSum = sum; bottomRight = { x, y }; }
      if (diff > maxDiff) { maxDiff = diff; topRight = { x, y }; }
      if (diff < minDiff) { minDiff = diff; bottomLeft = { x, y }; }
    }
  }
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) return null;
  return { topLeft, topRight, bottomRight, bottomLeft };
}

function orderCorners(points = []) {
  if (points.length !== 4) return null;
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  const ordered = [...points].sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
  let start = 0;
  let best = Infinity;
  ordered.forEach((point, index) => {
    const value = point.x + point.y;
    if (value < best) { best = value; start = index; }
  });
  const rotated = ordered.slice(start).concat(ordered.slice(0, start));
  if (rotated[1].x < rotated[3].x) return {
    topLeft: rotated[0],
    topRight: rotated[3],
    bottomRight: rotated[2],
    bottomLeft: rotated[1],
  };
  return {
    topLeft: rotated[0],
    topRight: rotated[1],
    bottomRight: rotated[2],
    bottomLeft: rotated[3],
  };
}

function gradientData(gray, width, height) {
  const gx = new Float32Array(width * height);
  const gy = new Float32Array(width * height);
  const samples = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width) + x;
      const a = gray[index - width - 1];
      const b = gray[index - width];
      const c = gray[index - width + 1];
      const d = gray[index - 1];
      const f = gray[index + 1];
      const g = gray[index + width - 1];
      const h = gray[index + width];
      const j = gray[index + width + 1];
      const xValue = (-a + c) + (-2 * d) + (2 * f) + (-g + j);
      const yValue = (-a - (2 * b) - c) + g + (2 * h) + j;
      gx[index] = xValue;
      gy[index] = yValue;
      if ((x + y) % 4 === 0) samples.push(Math.hypot(xValue, yValue));
    }
  }
  return { gx, gy, threshold: Math.max(28, percentile(samples, 0.78)) };
}

function fitLine(points = []) {
  if (points.length < 7) return null;
  let totalWeight = 0;
  let centerX = 0;
  let centerY = 0;
  for (const point of points) {
    const weight = Math.max(1, Number(point.weight || 1));
    totalWeight += weight;
    centerX += point.x * weight;
    centerY += point.y * weight;
  }
  centerX /= totalWeight;
  centerY /= totalWeight;
  let covXX = 0;
  let covYY = 0;
  let covXY = 0;
  for (const point of points) {
    const weight = Math.max(1, Number(point.weight || 1));
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    covXX += weight * dx * dx;
    covYY += weight * dy * dy;
    covXY += weight * dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  return { point: { x: centerX, y: centerY }, direction: { x: Math.cos(angle), y: Math.sin(angle) } };
}

function refineSide(gradient, width, height, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const nx = -dy / length;
  const ny = dx / length;
  const searchRadius = Math.max(4, Math.min(18, Math.round(Math.min(width, height) * 0.035)));
  const steps = Math.max(16, Math.min(48, Math.round(length / 5)));
  const points = [];

  for (let step = 1; step < steps; step += 1) {
    const t = step / steps;
    const baseX = start.x + (dx * t);
    const baseY = start.y + (dy * t);
    let bestStrength = 0;
    let bestPoint = null;
    for (let offset = -searchRadius; offset <= searchRadius; offset += 1) {
      const x = Math.round(baseX + (nx * offset));
      const y = Math.round(baseY + (ny * offset));
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
      const index = (y * width) + x;
      const aligned = Math.abs((gradient.gx[index] * nx) + (gradient.gy[index] * ny));
      if (aligned > bestStrength) {
        bestStrength = aligned;
        bestPoint = { x, y, weight: aligned };
      }
    }
    if (bestPoint && bestStrength >= gradient.threshold * 0.42) points.push(bestPoint);
  }

  return fitLine(points);
}

function lineIntersection(a, b, fallback) {
  if (!a || !b) return fallback;
  const cross = (a.direction.x * b.direction.y) - (a.direction.y * b.direction.x);
  if (Math.abs(cross) < 1e-5) return fallback;
  const qx = b.point.x - a.point.x;
  const qy = b.point.y - a.point.y;
  const t = ((qx * b.direction.y) - (qy * b.direction.x)) / cross;
  return { x: a.point.x + (t * a.direction.x), y: a.point.y + (t * a.direction.y) };
}

function refineQuad(corners, gradient, width, height) {
  if (!corners) return null;
  const top = refineSide(gradient, width, height, corners.topLeft, corners.topRight);
  const right = refineSide(gradient, width, height, corners.topRight, corners.bottomRight);
  const bottom = refineSide(gradient, width, height, corners.bottomLeft, corners.bottomRight);
  const left = refineSide(gradient, width, height, corners.topLeft, corners.bottomLeft);
  const margin = Math.max(width, height) * 0.06;
  const refined = {
    topLeft: lineIntersection(top, left, corners.topLeft),
    topRight: lineIntersection(top, right, corners.topRight),
    bottomRight: lineIntersection(bottom, right, corners.bottomRight),
    bottomLeft: lineIntersection(bottom, left, corners.bottomLeft),
  };
  for (const name of CORNER_NAMES) {
    refined[name] = {
      x: clamp(refined[name].x, -margin, width + margin),
      y: clamp(refined[name].y, -margin, height + margin),
    };
  }
  return refined;
}

function sampleIndex(x, y, width, height) {
  const sx = Math.max(0, Math.min(width - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(height - 1, Math.round(y)));
  return (sy * width) + sx;
}

function edgeSupport(corners, gradient, width, height) {
  const sides = [
    [corners.topLeft, corners.topRight],
    [corners.topRight, corners.bottomRight],
    [corners.bottomRight, corners.bottomLeft],
    [corners.bottomLeft, corners.topLeft],
  ];
  let total = 0;
  let count = 0;
  for (const [start, end] of sides) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / length;
    const ny = dx / length;
    for (let step = 1; step < 18; step += 1) {
      const t = step / 18;
      const x = start.x + (dx * t);
      const y = start.y + (dy * t);
      let strongest = 0;
      for (let offset = -2; offset <= 2; offset += 1) {
        const index = sampleIndex(x + (nx * offset), y + (ny * offset), width, height);
        strongest = Math.max(strongest, Math.abs((gradient.gx[index] * nx) + (gradient.gy[index] * ny)));
      }
      total += clamp(strongest / Math.max(1, gradient.threshold * 3.2));
      count += 1;
    }
  }
  return count ? total / count : 0;
}

function angleScore(a, vertex, b) {
  const ax = a.x - vertex.x;
  const ay = a.y - vertex.y;
  const bx = b.x - vertex.x;
  const by = b.y - vertex.y;
  const denominator = Math.max(1e-6, Math.hypot(ax, ay) * Math.hypot(bx, by));
  return clamp(1 - Math.abs(((ax * bx) + (ay * by)) / denominator));
}

export function scoreQuadGeometry(corners, width, height) {
  if (!corners || CORNER_NAMES.some(name => !corners[name])) return 0;
  const area = polygonArea(corners);
  const coverage = area / Math.max(1, width * height);
  if (coverage < 0.07 || coverage > 0.96) return 0;
  const shape = [
    angleScore(corners.bottomLeft, corners.topLeft, corners.topRight),
    angleScore(corners.topLeft, corners.topRight, corners.bottomRight),
    angleScore(corners.topRight, corners.bottomRight, corners.bottomLeft),
    angleScore(corners.bottomRight, corners.bottomLeft, corners.topLeft),
  ].reduce((sum, value) => sum + value, 0) / 4;
  const documentWidth = (distance(corners.topLeft, corners.topRight) + distance(corners.bottomLeft, corners.bottomRight)) / 2;
  const documentHeight = (distance(corners.topLeft, corners.bottomLeft) + distance(corners.topRight, corners.bottomRight)) / 2;
  const aspect = Math.max(documentWidth, documentHeight) / Math.max(1, Math.min(documentWidth, documentHeight));
  const aspectScore = aspect <= 2.35 ? 1 : clamp(1 - ((aspect - 2.35) / 1.4));
  const coverageScore = clamp(1 - (Math.abs(coverage - 0.5) / 0.55));
  return clamp((shape * 0.55) + (aspectScore * 0.25) + (coverageScore * 0.2));
}

function maskSupport(corners, mask, width, height) {
  let hits = 0;
  let count = 0;
  for (let row = 1; row <= 7; row += 1) {
    for (let column = 1; column <= 7; column += 1) {
      const point = bilinearPoint(corners, column / 8, row / 8);
      hits += mask[sampleIndex(point.x, point.y, width, height)] ? 1 : 0;
      count += 1;
    }
  }
  return count ? hits / count : 0;
}

function interiorPaperScore(corners, features) {
  let brightness = 0;
  let color = 0;
  let count = 0;
  for (let row = 1; row <= 6; row += 1) {
    for (let column = 1; column <= 6; column += 1) {
      const point = bilinearPoint(corners, column / 7, row / 7);
      const index = sampleIndex(point.x, point.y, features.width, features.height);
      brightness += features.gray[index];
      color += features.chroma[index];
      count += 1;
    }
  }
  if (!count) return 0;
  const averageBrightness = brightness / count;
  const averageChroma = color / count;
  return clamp(((averageBrightness - 55) / 155) * 0.58 + ((95 - averageChroma) / 95) * 0.42);
}

function borderPenalty(corners, width, height) {
  const margin = Math.min(width, height) * 0.025;
  let touches = 0;
  for (const name of CORNER_NAMES) {
    const point = corners[name];
    if (point.x <= margin || point.y <= margin || point.x >= width - margin || point.y >= height - margin) touches += 1;
  }
  const coverage = polygonArea(corners) / Math.max(1, width * height);
  if (coverage > 0.9) return 0.72;
  if (touches >= 3 && coverage > 0.72) return 0.58;
  if (touches >= 2 && coverage > 0.8) return 0.4;
  return touches * 0.035;
}

function candidateScore(corners, features, gradient, mask) {
  const geometry = scoreQuadGeometry(corners, features.width, features.height);
  if (!geometry) return 0;
  const edges = edgeSupport(corners, gradient, features.width, features.height);
  const support = maskSupport(corners, mask, features.width, features.height);
  const paper = interiorPaperScore(corners, features);
  const center = bilinearPoint(corners, 0.5, 0.5);
  const centerDistance = Math.hypot(
    (center.x - (features.width / 2)) / Math.max(1, features.width),
    (center.y - (features.height / 2)) / Math.max(1, features.height),
  );
  const centerScore = clamp(1 - (centerDistance / 0.72));
  const penalty = borderPenalty(corners, features.width, features.height);
  return clamp((edges * 0.34) + (support * 0.24) + (paper * 0.16) + (geometry * 0.17) + (centerScore * 0.09) - penalty);
}

function projectionCandidate(gradient, width, height) {
  const rowScores = new Float64Array(height);
  const columnScores = new Float64Array(width);
  for (let y = 2; y < height - 2; y += 1) {
    for (let x = 2; x < width - 2; x += 2) {
      const index = (y * width) + x;
      rowScores[y] += Math.abs(gradient.gy[index]);
      columnScores[x] += Math.abs(gradient.gx[index]);
    }
  }
  const best = (values, start, end) => {
    let bestIndex = -1;
    let bestValue = 0;
    for (let index = Math.max(1, Math.round(start)); index <= Math.min(values.length - 2, Math.round(end)); index += 1) {
      const value = values[index - 1] + (2 * values[index]) + values[index + 1];
      if (value > bestValue) { bestValue = value; bestIndex = index; }
    }
    return bestIndex;
  };
  const top = best(rowScores, height * 0.06, height * 0.46);
  const bottom = best(rowScores, height * 0.54, height * 0.94);
  const left = best(columnScores, width * 0.06, width * 0.46);
  const right = best(columnScores, width * 0.54, width * 0.94);
  if (top < 0 || bottom < 0 || left < 0 || right < 0 || right - left < width * 0.25 || bottom - top < height * 0.25) return null;
  return { topLeft: { x: left, y: top }, topRight: { x: right, y: top }, bottomRight: { x: right, y: bottom }, bottomLeft: { x: left, y: bottom } };
}

function candidateDistance(a, b) {
  return CORNER_NAMES.reduce((sum, name) => sum + distance(a[name], b[name]), 0) / 4;
}

export function detectDocumentFromImageData(imageData) {
  const features = featuresFromImageData(imageData);
  if (features.width < 48 || features.height < 48) return null;
  const gradient = gradientData(features.gray, features.width, features.height);
  const balancedMask = closeMask(buildPaperMask(features, 'balanced'), features.width, features.height, 1);
  const candidates = [];
  const modes = ['strict', 'balanced', 'shadow'];

  for (const mode of modes) {
    const rawMask = mode === 'balanced' ? balancedMask : closeMask(buildPaperMask(features, mode), features.width, features.height, 1);
    const { labels, components } = connectedComponents(rawMask, features.width, features.height);
    const minimumArea = features.width * features.height * 0.055;
    const maximumArea = features.width * features.height * 0.93;
    const selected = components
      .filter(component => component.area >= minimumArea && component.area <= maximumArea)
      .sort((a, b) => b.area - a.area)
      .slice(0, 5);

    for (const component of selected) {
      const boxes = [orientedBox(component, labels, features.width, features.height), diagonalBox(component, labels, features.width)];
      for (const box of boxes) {
        if (!box) continue;
        const refined = refineQuad(box, gradient, features.width, features.height);
        if (!refined || !scoreQuadGeometry(refined, features.width, features.height)) continue;
        if (candidates.some(candidate => candidateDistance(candidate.corners, refined) < Math.min(features.width, features.height) * 0.035)) continue;
        candidates.push({ corners: refined, score: candidateScore(refined, features, gradient, balancedMask) });
      }
    }
  }

  const projected = projectionCandidate(gradient, features.width, features.height);
  if (projected) {
    const refined = refineQuad(projected, gradient, features.width, features.height);
    if (refined) candidates.push({ corners: refined, score: candidateScore(refined, features, gradient, balancedMask) });
  }

  const best = candidates.sort((a, b) => b.score - a.score)[0] || null;
  if (!best || best.score < 0.37) return null;
  return { ...best.corners, confidence: best.score };
}

export function detectDocumentPro(source, maxSide = 380) {
  if (!source || typeof document === 'undefined') return null;
  try {
    const width = Math.max(1, Number(source.width || source.videoWidth || 1));
    const height = Math.max(1, Number(source.height || source.videoHeight || 1));
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const detected = detectDocumentFromImageData(context.getImageData(0, 0, canvas.width, canvas.height));
    if (!detected) return null;
    const inverseScale = 1 / Math.max(scale, 1e-6);
    return Object.fromEntries(CORNER_NAMES.map(name => [name, {
      x: clamp(detected[name].x * inverseScale, 0, width),
      y: clamp(detected[name].y * inverseScale, 0, height),
    }]));
  } catch {
    return null;
  }
}

export function smoothDetectedCorners(previous, current) {
  if (!current) return null;
  if (!previous) return current;
  const motion = CORNER_NAMES.reduce((sum, name) => sum + distance(previous[name], current[name]), 0) / 4;
  if (!Number.isFinite(motion) || motion > 0.12) return current;
  const currentWeight = motion < 0.018 ? 0.32 : motion < 0.05 ? 0.5 : 0.68;
  return Object.fromEntries(CORNER_NAMES.map(name => [name, {
    x: (previous[name].x * (1 - currentWeight)) + (current[name].x * currentWeight),
    y: (previous[name].y * (1 - currentWeight)) + (current[name].y * currentWeight),
  }]));
}
