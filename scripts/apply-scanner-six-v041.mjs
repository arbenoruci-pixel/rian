import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const VERSION = '0.4.1';

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function write(relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function replaceRequired(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  if (!source.includes(oldValue)) throw new Error(`Scanner 0.4.1 patch target missing: ${label}`);
  return source.replace(oldValue, newValue);
}

let curvedBoundary = read('lib/scanner/curvedBoundary.js');
const handlesStart = curvedBoundary.indexOf('export function boundaryHandles(boundary = {}) {');
const handlesEnd = curvedBoundary.indexOf('export function boundaryPathPoints', handlesStart);
if (handlesStart < 0 || handlesEnd < 0) {
  throw new Error('Scanner 0.4.1 could not locate boundaryHandles().');
}

const sixHandleImplementation = `function sixHandleLineDistance(point, start, end) {
  const dx = Number(end?.x || 0) - Number(start?.x || 0);
  const dy = Number(end?.y || 0) - Number(start?.y || 0);
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared < 1e-6) {
    return Math.hypot(Number(point?.x || 0) - Number(start?.x || 0), Number(point?.y || 0) - Number(start?.y || 0));
  }
  const t = clamp(
    (((Number(point?.x || 0) - Number(start?.x || 0)) * dx)
      + ((Number(point?.y || 0) - Number(start?.y || 0)) * dy)) / lengthSquared,
    0,
    1,
  );
  const projectedX = Number(start?.x || 0) + (dx * t);
  const projectedY = Number(start?.y || 0) + (dy * t);
  return Math.hypot(Number(point?.x || 0) - projectedX, Number(point?.y || 0) - projectedY);
}

function sixHandleBowScore(points = []) {
  if (points.length < 3) return 0;
  const start = points[0];
  const end = points.at(-1);
  const sideLength = Math.max(1, Math.hypot(
    Number(end?.x || 0) - Number(start?.x || 0),
    Number(end?.y || 0) - Number(start?.y || 0),
  ));
  let maximum = 0;
  let total = 0;
  let count = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const normalized = sixHandleLineDistance(points[index], start, end) / sideLength;
    maximum = Math.max(maximum, normalized);
    total += normalized;
    count += 1;
  }
  return (maximum * 0.72) + ((count ? total / count : 0) * 0.28);
}

export function boundaryHandles(boundary = {}) {
  const top = boundary.top || [];
  const right = boundary.right || [];
  const bottom = boundary.bottom || [];
  const left = boundary.left || [];
  const topLast = Math.max(0, top.length - 1);
  const rightLast = Math.max(0, right.length - 1);
  const bottomLast = Math.max(0, bottom.length - 1);
  const leftLast = Math.max(0, left.length - 1);
  const middle = last => Math.max(1, Math.min(last - 1, Math.round(last / 2)));
  const handles = [];
  const seen = new Set();
  const push = (side, index, isCorner = false) => {
    const point = boundary?.[side]?.[index];
    const key = side + ':' + index;
    if (!point || seen.has(key)) return;
    seen.add(key);
    handles.push({ side, index, point, isCorner });
  };

  const horizontalBow = sixHandleBowScore(top) + sixHandleBowScore(bottom);
  const verticalBow = sixHandleBowScore(right) + sixHandleBowScore(left);
  const useVerticalBendHandles = verticalBow > Math.max(0.006, horizontalBow * 1.18);

  if (useVerticalBendHandles && rightLast > 1 && leftLast > 1) {
    push('top', 0, true);
    push('top', topLast, true);
    push('right', middle(rightLast), false);
    push('bottom', bottomLast, true);
    push('bottom', 0, true);
    push('left', middle(leftLast), false);
  } else {
    push('top', 0, true);
    push('top', middle(topLast), false);
    push('top', topLast, true);
    push('bottom', bottomLast, true);
    push('bottom', middle(bottomLast), false);
    push('bottom', 0, true);
  }

  return handles.slice(0, 6);
}

`;
curvedBoundary = curvedBoundary.slice(0, handlesStart)
  + sixHandleImplementation
  + curvedBoundary.slice(handlesEnd);
write('lib/scanner/curvedBoundary.js', curvedBoundary);

let component = read('components/ScannerLab.jsx');
component = replaceRequired(component, 'SCANNER CORE · DEMO 0.4', 'SCANNER CORE · DEMO 0.4.1', 'visible demo version');
component = replaceRequired(component, "engineReady ? 'Local engine ready · 0.4'", "engineReady ? 'Local engine ready · 0.4.1'", 'engine version');
component = replaceRequired(component, 'build 0.4', 'build 0.4.1', 'footer version');
component = replaceRequired(component, '16-point curved-edge control', '6-point smart edge control', 'review control title');
component = replaceRequired(
  component,
  'Drag the corners and smaller edge points onto the real paper boundary. Curved and bent pages are flattened from this shape.',
  'Drag four corners and the two smart bend points. Hidden edge geometry stays automatic and keeps curved pages smooth.',
  'review control instruction',
);
write('components/ScannerLab.jsx', component);

write('public/scanner-engine.json', `${JSON.stringify({
  version: VERSION,
  mode: 'local-js-pro',
  externalRuntime: false,
  liveAnalysisSide: 340,
  fineAnalysisSide: 520,
  detector: 'multi-mask-components-plus-rotation-aware-edge-refinement',
  perspective: 'canvas-coons-boundary-mesh',
  visibleHandles: 6,
  internalBoundaryPoints: 16,
  handlePolicy: 'four-corners-plus-smart-bend-pair',
  safeguards: ['full-frame-rejection', 'shadow-mask', 'temporal-smoothing', 'fine-capture-refinement'],
}, null, 2)}\n`);

write('public/scanner-build.json', `${JSON.stringify({
  version: VERSION,
  engine: 'local-js-pro',
  externalRuntime: false,
  visibleHandles: 6,
  serviceWorker: false,
  cachePolicy: 'no-store',
}, null, 2)}\n`);

write('tests/six-handle-v041.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaryFromCorners, boundaryHandles } from '../lib/scanner/curvedBoundary.js';

const corners = {
  topLeft:{ x:20, y:20 },
  topRight:{ x:220, y:20 },
  bottomRight:{ x:220, y:320 },
  bottomLeft:{ x:20, y:320 },
};

test('review editor exposes exactly six handles', () => {
  const handles = boundaryHandles(boundaryFromCorners(corners, 5));
  assert.equal(handles.length, 6);
  assert.equal(handles.filter(handle => handle.isCorner).length, 4);
  assert.equal(handles.filter(handle => !handle.isCorner).length, 2);
});

test('straight pages default to top and bottom bend handles', () => {
  const handles = boundaryHandles(boundaryFromCorners(corners, 5));
  assert.deepEqual(
    handles.filter(handle => !handle.isCorner).map(handle => handle.side),
    ['top', 'bottom'],
  );
});

test('side-bowed pages move the two smart handles onto left and right edges', () => {
  const boundary = boundaryFromCorners(corners, 5);
  boundary.right[2] = { x:270, y:170 };
  boundary.left[2] = { x:-30, y:170 };
  const handles = boundaryHandles(boundary);
  assert.deepEqual(
    handles.filter(handle => !handle.isCorner).map(handle => handle.side),
    ['right', 'left'],
  );
});
`);

const checks = [
  ['lib/scanner/curvedBoundary.js', 'sixHandleBowScore'],
  ['lib/scanner/curvedBoundary.js', 'return handles.slice(0, 6)'],
  ['components/ScannerLab.jsx', '6-point smart edge control'],
  ['components/ScannerLab.jsx', 'Local engine ready · 0.4.1'],
  ['public/scanner-engine.json', 'four-corners-plus-smart-bend-pair'],
];
for (const [relative, marker] of checks) {
  if (!read(relative).includes(marker)) throw new Error(`${relative} is missing ${marker}`);
}
if (read('components/ScannerLab.jsx').includes('16-point curved-edge control')) {
  throw new Error('The 16-handle review UI is still visible.');
}

console.log('PASS — Scanner Lab 0.4.1 shows six smart handles while preserving the internal curved-page model.');
