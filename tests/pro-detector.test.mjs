import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDocumentFromImageData,
  scoreQuadGeometry,
  smoothDetectedCorners,
} from '../lib/scanner/proDetector.js';

const NAMES = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];

function pointInQuad(x, y, quad) {
  const points = NAMES.map(name => quad[name]);
  let sign = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const cross = ((b.x - a.x) * (y - a.y)) - ((b.y - a.y) * (x - a.x));
    if (Math.abs(cross) < 1e-6) continue;
    const nextSign = Math.sign(cross);
    if (!sign) sign = nextSign;
    else if (sign !== nextSign) return false;
  }
  return true;
}

function makeImage(width, height, quad, { shadow = false } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = ((y * width) + x) * 4;
      let r = 145 + Math.round(22 * Math.sin(y / 17));
      let g = 22 + Math.round(7 * Math.sin(x / 13));
      let b = 48 + Math.round(8 * Math.cos(y / 15));
      if (pointInQuad(x, y, quad)) {
        let value = 232;
        if (shadow && x < width * 0.52) value = 88 + Math.round((x / (width * 0.52)) * 92);
        if (((y + (2 * x)) % 31) < 2 || (y % 17 === 0 && x > 95 && x < 250)) value -= 45;
        r = value;
        g = value - 2;
        b = value - 5;
      }
      data[offset] = Math.max(0, Math.min(255, r));
      data[offset + 1] = Math.max(0, Math.min(255, g));
      data[offset + 2] = Math.max(0, Math.min(255, b));
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}

function averageCornerError(found, expected) {
  return NAMES.reduce((sum, name) => sum + Math.hypot(
    found[name].x - expected[name].x,
    found[name].y - expected[name].y,
  ), 0) / NAMES.length;
}

test('rotation-aware detector finds a tilted page instead of the camera frame', () => {
  const expected = {
    topLeft: { x: 78, y: 38 },
    topRight: { x: 270, y: 56 },
    bottomRight: { x: 242, y: 218 },
    bottomLeft: { x: 48, y: 195 },
  };
  const found = detectDocumentFromImageData(makeImage(320, 240, expected));
  assert.ok(found, 'tilted document should be detected');
  assert.ok(averageCornerError(found, expected) < 14, 'corners should stay close to the tilted page');
  assert.ok(scoreQuadGeometry(found, 320, 240) > 0.65);
});

test('detector keeps a shadowed document boundary', () => {
  const expected = {
    topLeft: { x: 74, y: 40 },
    topRight: { x: 268, y: 45 },
    bottomRight: { x: 255, y: 220 },
    bottomLeft: { x: 56, y: 215 },
  };
  const found = detectDocumentFromImageData(makeImage(320, 240, expected, { shadow: true }));
  assert.ok(found, 'shadowed document should be detected');
  assert.ok(averageCornerError(found, expected) < 18, 'shadow should not pull the crop onto the background');
});

test('detector rejects a colorful background without paper', () => {
  const offscreen = {
    topLeft: { x: -100, y: -100 },
    topRight: { x: -90, y: -100 },
    bottomRight: { x: -90, y: -90 },
    bottomLeft: { x: -100, y: -90 },
  };
  assert.equal(detectDocumentFromImageData(makeImage(320, 240, offscreen)), null);
});

test('temporal smoothing reduces small corner jitter', () => {
  const previous = {
    topLeft: { x: 0.1, y: 0.1 },
    topRight: { x: 0.8, y: 0.1 },
    bottomRight: { x: 0.8, y: 0.8 },
    bottomLeft: { x: 0.1, y: 0.8 },
  };
  const current = {
    topLeft: { x: 0.11, y: 0.1 },
    topRight: { x: 0.81, y: 0.1 },
    bottomRight: { x: 0.81, y: 0.8 },
    bottomLeft: { x: 0.11, y: 0.8 },
  };
  const smoothed = smoothDetectedCorners(previous, current);
  assert.ok(smoothed.topLeft.x > previous.topLeft.x);
  assert.ok(smoothed.topLeft.x < current.topLeft.x);
});
