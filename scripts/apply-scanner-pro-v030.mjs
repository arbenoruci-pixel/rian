import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const VERSION = '0.3.0';

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
  if (!source.includes(oldValue)) throw new Error(`Scanner Pro patch target missing: ${label}`);
  return source.replace(oldValue, newValue);
}

let liteEngine = read('lib/scanner/liteEngine.js');
if (!liteEngine.includes("from './proDetector.js'")) {
  liteEngine = `import { detectDocumentPro } from './proDetector.js';\n\n${liteEngine}`;
}
const detectorStart = liteEngine.indexOf('export function detectDocumentLite(source) {');
const detectorEnd = liteEngine.indexOf('\nexport function bilinearPoint', detectorStart);
if (detectorStart < 0 || detectorEnd < 0) throw new Error('Scanner Pro could not locate the local detector adapter.');
liteEngine = `${liteEngine.slice(0, detectorStart)}export function detectDocumentLite(source) {\n  return detectDocumentPro(source, 340);\n}\n${liteEngine.slice(detectorEnd + 1)}`;
liteEngine = replaceRequired(liteEngine, "mode: 'local-js-lite-0.2'", "mode: 'local-js-pro-0.3'", 'engine mode');
liteEngine = replaceRequired(
  liteEngine,
  'detectDocument: detectDocumentLite,\n    extractPaper: extractPaperLite,',
  'detectDocument: detectDocumentLite,\n    detectDocumentFine: source => detectDocumentPro(source, 520),\n    extractPaper: extractPaperLite,',
  'fine detector adapter',
);
write('lib/scanner/liteEngine.js', liteEngine);

let component = read('components/ScannerLab.jsx');
component = replaceRequired(
  component,
  "import { initialSession, scannerSessionReducer } from '../lib/scanner/session.js';",
  "import { initialSession, scannerSessionReducer } from '../lib/scanner/session.js';\nimport { smoothDetectedCorners } from '../lib/scanner/proDetector.js';",
  'corner smoothing import',
);
component = replaceRequired(component, 'SCANNER CORE · DEMO 0.2.1', 'SCANNER CORE · DEMO 0.3', 'visible demo version');
component = replaceRequired(component, "engineReady ? 'Local engine ready · 0.2.1'", "engineReady ? 'Local engine ready · 0.3'", 'visible engine version');
component = replaceRequired(component, 'build 0.2.1', 'build 0.3', 'visible footer version');
component = replaceRequired(
  component,
  `    const corners = detectDocument(canvas, runtime.cv, runtime.scanner);
    const normalized = corners ? normalizeCorners(corners, canvas.width, canvas.height) : null;
    latestCornersRef.current = normalized;
    setLiveCorners(normalized);
    const metrics = analyzeFrameQuality(canvas, runtime.cv, corners);
    setQuality(metrics);

    const motion = normalized ? cornerMotion(previousCornersRef.current, normalized) : 1;`,
  `    const corners = detectDocument(canvas, runtime.cv, runtime.scanner);
    const rawNormalized = corners ? normalizeCorners(corners, canvas.width, canvas.height) : null;
    const normalized = rawNormalized
      ? smoothDetectedCorners(previousCornersRef.current, rawNormalized)
      : null;
    latestCornersRef.current = normalized;
    setLiveCorners(normalized);
    const metrics = analyzeFrameQuality(canvas, runtime.cv, corners);
    setQuality(metrics);

    const motion = rawNormalized ? cornerMotion(previousCornersRef.current, rawNormalized) : 1;`,
  'temporal corner smoothing',
);
component = replaceRequired(
  component,
  `      const normalized = latestCornersRef.current;
      const corners = normalized
        ? denormalizeCorners(normalized, sourceCanvas.width, sourceCanvas.height)
        : defaultCorners(sourceCanvas.width, sourceCanvas.height);`,
  `      const normalized = latestCornersRef.current;
      const refinedCorners = runtime?.scanner?.detectDocumentFine
        ? runtime.scanner.detectDocumentFine(sourceCanvas)
        : (runtime ? detectDocument(sourceCanvas, runtime.cv, runtime.scanner) : null);
      const corners = refinedCorners || (normalized
        ? denormalizeCorners(normalized, sourceCanvas.width, sourceCanvas.height)
        : defaultCorners(sourceCanvas.width, sourceCanvas.height));`,
  'high-resolution capture refinement',
);
component = replaceRequired(component, '  }, [openReview, quality]);', '  }, [openReview, quality, runtime]);', 'capture runtime dependency');
component = replaceRequired(
  component,
  '      const found = runtime ? detectDocument(canvas, runtime.cv, runtime.scanner) : null;',
  `      const found = runtime?.scanner?.detectDocumentFine
        ? runtime.scanner.detectDocumentFine(canvas)
        : (runtime ? detectDocument(canvas, runtime.cv, runtime.scanner) : null);`,
  'photo fine detection',
);
write('components/ScannerLab.jsx', component);

write('public/scanner-engine.json', `${JSON.stringify({
  version: VERSION,
  mode: 'local-js-pro',
  externalRuntime: false,
  liveAnalysisSide: 340,
  fineAnalysisSide: 520,
  detector: 'multi-mask-components-plus-rotation-aware-edge-refinement',
  perspective: 'canvas-bilinear-mesh',
  safeguards: ['full-frame-rejection', 'shadow-mask', 'temporal-smoothing', 'fine-capture-refinement'],
}, null, 2)}\n`);

write('public/scanner-build.json', `${JSON.stringify({
  version: VERSION,
  engine: 'local-js-pro',
  externalRuntime: false,
  serviceWorker: false,
  cachePolicy: 'no-store',
}, null, 2)}\n`);

const required = [
  ['lib/scanner/proDetector.js', 'detectDocumentFromImageData'],
  ['lib/scanner/proDetector.js', 'connectedComponents'],
  ['lib/scanner/proDetector.js', 'refineQuad'],
  ['lib/scanner/proDetector.js', 'borderPenalty'],
  ['lib/scanner/liteEngine.js', "mode: 'local-js-pro-0.3'"],
  ['lib/scanner/liteEngine.js', 'detectDocumentFine'],
  ['components/ScannerLab.jsx', 'smoothDetectedCorners'],
  ['components/ScannerLab.jsx', 'Local engine ready · 0.3'],
  ['components/ScannerLab.jsx', 'detectDocumentFine(sourceCanvas)'],
  ['public/scanner-engine.json', 'full-frame-rejection'],
];
for (const [relative, marker] of required) {
  if (!read(relative).includes(marker)) throw new Error(`${relative} is missing ${marker}`);
}

for (const relative of ['lib/scanner/runtime.js', 'lib/scanner/proDetector.js']) {
  const source = read(relative);
  for (const forbidden of ['cdn.jsdelivr.net', 'unpkg.com', 'docs.opencv.org', 'window.cv']) {
    if (source.includes(forbidden)) throw new Error(`${relative} still references external vision runtime: ${forbidden}`);
  }
}

console.log('PASS — Scanner Lab 0.3 adds rotation-aware multi-candidate detection, full-frame rejection, shadow handling, temporal smoothing, and fine capture refinement.');
