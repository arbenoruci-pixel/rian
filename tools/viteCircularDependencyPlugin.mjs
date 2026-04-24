import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JS_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.vercel',
  'coverage',
]);

function normalizePath(value) {
  return String(value || "").replace(/\\\\/g, "/");
}

function isCodeFile(filePath) {
  return JS_EXTENSIONS.includes(path.extname(filePath));
}

function walkFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env') {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(full, out);
    } else if (entry.isFile() && isCodeFile(full)) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source) {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractImportSpecifiers(source) {
  const clean = stripComments(source);
  const specs = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const re of patterns) {
    let match;
    while ((match = re.exec(clean))) {
      const spec = String(match[1] || '').trim();
      if (spec) specs.push(spec);
    }
  }
  return specs;
}

function tryResolveFile(candidate) {
  if (!candidate) return null;
  try {
    const stat = fs.existsSync(candidate) ? fs.statSync(candidate) : null;
    if (stat?.isFile() && isCodeFile(candidate)) return candidate;
    if (stat?.isDirectory()) {
      for (const ext of JS_EXTENSIONS) {
        const indexFile = path.join(candidate, `index${ext}`);
        if (fs.existsSync(indexFile)) return indexFile;
      }
    }
  } catch {}

  const ext = path.extname(candidate);
  if (ext) {
    if (fs.existsSync(candidate) && isCodeFile(candidate)) return candidate;
    return null;
  }

  for (const jsExt of JS_EXTENSIONS) {
    const file = `${candidate}${jsExt}`;
    if (fs.existsSync(file)) return file;
  }

  for (const jsExt of JS_EXTENSIONS) {
    const indexFile = path.join(candidate, `index${jsExt}`);
    if (fs.existsSync(indexFile)) return indexFile;
  }

  return null;
}

function resolveImport(spec, fromFile, rootDir) {
  if (!spec || spec.startsWith('\0')) return null;
  if (spec.startsWith('node:')) return null;

  let base = null;
  if (spec.startsWith('@/')) {
    base = path.resolve(rootDir, spec.slice(2));
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else if (spec.startsWith('/')) {
    base = path.resolve(rootDir, `.${spec}`);
  } else {
    return null;
  }

  const resolved = tryResolveFile(base);
  if (!resolved) return null;
  return path.normalize(resolved);
}

function buildGraph(rootDir) {
  const files = walkFiles(rootDir).map((file) => path.normalize(file));
  const fileSet = new Set(files);
  const graph = new Map();

  for (const file of files) {
    let source = '';
    try { source = fs.readFileSync(file, 'utf8'); } catch {}
    const deps = [];
    for (const spec of extractImportSpecifiers(source)) {
      const resolved = resolveImport(spec, file, rootDir);
      if (resolved && fileSet.has(resolved)) deps.push(resolved);
    }
    graph.set(file, Array.from(new Set(deps)));
  }

  return graph;
}

function canonicalCycleKey(cycle) {
  const body = cycle.slice(0, -1);
  if (!body.length) return '';
  const rotations = body.map((_, idx) => body.slice(idx).concat(body.slice(0, idx)).join('>'));
  rotations.sort();
  return rotations[0];
}

export function findCircularDependencies(rootDir) {
  const graph = buildGraph(rootDir);
  const visited = new Set();
  const active = new Set();
  const stack = [];
  const cycles = [];
  const seen = new Set();

  function visit(file) {
    if (active.has(file)) {
      const idx = stack.indexOf(file);
      if (idx >= 0) {
        const cycle = stack.slice(idx).concat(file);
        const key = canonicalCycleKey(cycle);
        if (key && !seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      }
      return;
    }
    if (visited.has(file)) return;

    visited.add(file);
    active.add(file);
    stack.push(file);

    for (const dep of graph.get(file) || []) visit(dep);

    stack.pop();
    active.delete(file);
  }

  for (const file of graph.keys()) visit(file);
  return cycles;
}

function formatCycle(cycle, rootDir) {
  return cycle
    .map((file, index) => {
      const rel = normalizePath(path.relative(rootDir, file));
      return `  ${index + 1}. ${rel}`;
    })
    .join('\n');
}

function printCircularReport(cycles, rootDir, failOnError) {
  if (!cycles.length) {
    console.log('\x1b[32m[vite:circular-deps] No circular dependencies found.\x1b[0m');
    return;
  }

  console.warn(`\n\x1b[31m[vite:circular-deps] Found ${cycles.length} circular import cycle(s).\x1b[0m`);
  cycles.forEach((cycle, index) => {
    console.warn(`\n\x1b[33mCycle ${index + 1}:\x1b[0m`);
    console.warn(formatCycle(cycle, rootDir));
  });
  console.warn('\n\x1b[36mFix strategy: move shared constants/helpers/types into a third file, or replace one side of the loop with a dynamic import.\x1b[0m\n');

  if (failOnError) {
    throw new Error(`[vite:circular-deps] Build stopped because ${cycles.length} circular dependency cycle(s) were found.`);
  }
}

export default function circularDependencyReporter(options = {}) {
  let rootDir = process.cwd();
  let timer = null;
  const failOnError = options.failOnError === true || process.env.CIRCULAR_FAIL === '1';

  function runScan() {
    const cycles = findCircularDependencies(rootDir);
    printCircularReport(cycles, rootDir, failOnError);
  }

  return {
    name: 'tepiha-circular-dependency-reporter',
    apply: 'serve',
    configResolved(config) {
      rootDir = config.root || rootDir;
    },
    buildStart() {
      runScan();
    },
    watchChange(id) {
      if (!id || !isCodeFile(id)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try { runScan(); } catch (err) { this.error(err); }
      }, 250);
    },
  };
}

export function circularDependencyReporterBuild(options = {}) {
  let rootDir = process.cwd();
  const failOnError = options.failOnError === true || process.env.CIRCULAR_FAIL === '1';
  return {
    name: 'tepiha-circular-dependency-reporter-build',
    apply: 'build',
    configResolved(config) {
      rootDir = config.root || rootDir;
    },
    buildStart() {
      const cycles = findCircularDependencies(rootDir);
      printCircularReport(cycles, rootDir, failOnError);
    },
  };
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFile && path.normalize(invokedFile) === path.normalize(currentFile)) {
  const rootArg = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const fail = process.env.CIRCULAR_FAIL === '1' || process.argv.includes('--fail');
  const cycles = findCircularDependencies(rootArg);
  printCircularReport(cycles, rootArg, fail);
  if (cycles.length && fail) process.exit(1);
}
