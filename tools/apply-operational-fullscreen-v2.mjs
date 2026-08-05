import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const APP_ROOT_PATH = 'src/AppRoot.jsx';
const GLOBALS_PATH = 'app/globals.css';
const COMPONENT_MARKER = 'OPERATIONAL_FULLSCREEN_V2_COMPONENT';
const CSS_MARKER = 'OPERATIONAL_FULLSCREEN_V2_CSS';

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(rel, content) {
  fs.writeFileSync(path.join(root, rel), content, 'utf8');
}

function patchAppRoot() {
  let source = read(APP_ROOT_PATH);
  let changed = false;

  if (!source.includes(COMPONENT_MARKER)) {
    const anchor = 'function RouteRequestTracker() {';
    if (!source.includes(anchor)) throw new Error('APP_ROOT_ROUTE_TRACKER_ANCHOR_NOT_FOUND');

    const component = String.raw`
// ${COMPONENT_MARKER}
const OPERATIONAL_FULLSCREEN_EXCLUDED_PREFIXES = [
  '/login',
  '/transport/login',
  '/porosit',
  '/k/',
  '/debug',
  '/diag',
  '/offline',
];

function shouldUseOperationalFullscreen(pathname = '/') {
  const clean = String(pathname || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (clean === '/login' || clean === '/transport/login' || clean === '/porosit' || clean === '/k') return false;
  return !OPERATIONAL_FULLSCREEN_EXCLUDED_PREFIXES.some((prefix) => clean === prefix || clean.startsWith(prefix));
}

function OperationalFullscreenRouteFlag() {
  const location = useLocation();

  React.useLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;

    const enabled = shouldUseOperationalFullscreen(location?.pathname || window.location?.pathname || '/');
    const html = document.documentElement;
    const body = document.body;
    const rootNode = document.getElementById('root');
    let rafId = 0;
    let timerFast = 0;
    let timerSlow = 0;
    let timerLate = 0;
    let observer = null;

    const clearMarks = () => {
      try {
        document.querySelectorAll('[data-tepiha-route-layout],[data-tepiha-route-page],[data-tepiha-route-wide]').forEach((node) => {
          node.removeAttribute('data-tepiha-route-layout');
          node.removeAttribute('data-tepiha-route-page');
          node.removeAttribute('data-tepiha-route-wide');
        });
      } catch {}
    };

    const clearFlags = () => {
      try { html?.removeAttribute?.('data-tepiha-operational-fullscreen'); } catch {}
      try { body?.removeAttribute?.('data-tepiha-operational-fullscreen'); } catch {}
      try { rootNode?.removeAttribute?.('data-tepiha-operational-fullscreen'); } catch {}
    };

    if (!enabled) {
      clearMarks();
      clearFlags();
      return undefined;
    }

    try { html?.setAttribute?.('data-tepiha-operational-fullscreen', '1'); } catch {}
    try { body?.setAttribute?.('data-tepiha-operational-fullscreen', '1'); } catch {}
    try { rootNode?.setAttribute?.('data-tepiha-operational-fullscreen', '1'); } catch {}

    const isElement = (node) => !!node && node.nodeType === 1;
    const viewportWidth = () => Math.max(1, Number(window.innerWidth || document.documentElement?.clientWidth || 0) || 1);

    const canBeRouteRoot = (node) => {
      if (!isElement(node)) return false;
      try {
        if (node.matches('script,style,link,[hidden],[aria-hidden="true"]')) return false;
        const rect = node.getBoundingClientRect();
        const computed = window.getComputedStyle(node);
        if (['fixed', 'absolute'].includes(String(computed?.position || '').toLowerCase())) return false;
        if (rect.width < Math.max(180, viewportWidth() * 0.55)) return false;
        if (rect.height < 42) return false;
        return true;
      } catch {
        return false;
      }
    };

    const canBeWideShell = (node, parentWidth) => {
      if (!isElement(node)) return false;
      try {
        if (node.matches('button,input,select,textarea,dialog,[role="dialog"],[aria-modal="true"]')) return false;
        const rect = node.getBoundingClientRect();
        const computed = window.getComputedStyle(node);
        const position = String(computed?.position || '').toLowerCase();
        if (position === 'fixed' || position === 'absolute') return false;
        const minimum = Math.max(viewportWidth() * 0.55, Number(parentWidth || 0) * 0.72);
        return rect.width >= minimum && rect.height >= 34;
      } catch {
        return false;
      }
    };

    const markLayout = (node) => {
      if (!isElement(node)) return;
      try { node.setAttribute('data-tepiha-route-layout', '1'); } catch {}
    };

    const markPage = (node) => {
      if (!isElement(node)) return;
      try { node.setAttribute('data-tepiha-route-page', '1'); } catch {}
    };

    const markWide = (node) => {
      if (!isElement(node)) return;
      try { node.setAttribute('data-tepiha-route-wide', '1'); } catch {}
    };

    const markCurrentRoute = () => {
      const root = document.getElementById('root');
      if (!root) return;
      clearMarks();

      const children = Array.from(root.children || []);
      const routeRoot = children.find(canBeRouteRoot) || children.find(isElement) || null;
      if (!routeRoot) return;

      markLayout(routeRoot);
      let pageNode = routeRoot;

      let arkaContainer = null;
      try {
        if (routeRoot.matches('.arka-container')) arkaContainer = routeRoot;
        else if (routeRoot.matches('.arka-shell')) arkaContainer = routeRoot.querySelector(':scope > .arka-container') || routeRoot.querySelector('.arka-container');
        else arkaContainer = routeRoot.querySelector(':scope > .arka-container');
      } catch {
        arkaContainer = null;
      }

      if (arkaContainer) {
        markLayout(arkaContainer);
        pageNode = arkaContainer.firstElementChild || arkaContainer;
      }

      markPage(pageNode);

      try {
        pageNode.querySelectorAll('.bonusShell,.bonusPage,.wrap,.arkaShell,.dispatchShell,.dispatchPage,.gatiShell,.gatiPage').forEach((node) => {
          const parentRect = node.parentElement?.getBoundingClientRect?.();
          if (canBeWideShell(node, parentRect?.width || viewportWidth())) markWide(node);
        });
      } catch {}

      let current = pageNode;
      for (let depth = 0; depth < 4; depth += 1) {
        if (!isElement(current)) break;
        let parentWidth = viewportWidth();
        try { parentWidth = current.getBoundingClientRect().width || parentWidth; } catch {}
        const candidate = Array.from(current.children || []).find((node) => canBeWideShell(node, parentWidth));
        if (!candidate) break;
        markWide(candidate);
        current = candidate;
      }
    };

    const scheduleMark = () => {
      try { if (rafId) window.cancelAnimationFrame(rafId); } catch {}
      try {
        rafId = window.requestAnimationFrame(() => {
          rafId = 0;
          markCurrentRoute();
        });
      } catch {
        markCurrentRoute();
      }
    };

    scheduleMark();
    timerFast = window.setTimeout(scheduleMark, 80);
    timerSlow = window.setTimeout(scheduleMark, 360);
    timerLate = window.setTimeout(scheduleMark, 1200);

    try {
      observer = new MutationObserver(scheduleMark);
      observer.observe(rootNode || document.body, { childList: true, subtree: true });
    } catch {
      observer = null;
    }

    try { window.addEventListener('resize', scheduleMark, { passive: true }); } catch {}
    try { window.addEventListener('pageshow', scheduleMark, { passive: true }); } catch {}
    try { window.addEventListener('tepiha:route-ui-alive', scheduleMark, { passive: true }); } catch {}

    return () => {
      try { if (rafId) window.cancelAnimationFrame(rafId); } catch {}
      try { window.clearTimeout(timerFast); } catch {}
      try { window.clearTimeout(timerSlow); } catch {}
      try { window.clearTimeout(timerLate); } catch {}
      try { observer?.disconnect?.(); } catch {}
      try { window.removeEventListener('resize', scheduleMark); } catch {}
      try { window.removeEventListener('pageshow', scheduleMark); } catch {}
      try { window.removeEventListener('tepiha:route-ui-alive', scheduleMark); } catch {}
      clearMarks();
      clearFlags();
    };
  }, [location?.pathname]);

  return null;
}
`;

    source = source.replace(anchor, `${component}\n${anchor}`);
    changed = true;
  }

  if (!source.includes('<OperationalFullscreenRouteFlag />')) {
    const anchor = '<AppRootMountedMarker />';
    if (!source.includes(anchor)) throw new Error('APP_ROOT_MOUNT_MARKER_ANCHOR_NOT_FOUND');
    source = source.replace(anchor, `${anchor}\n      <OperationalFullscreenRouteFlag />`);
    changed = true;
  }

  if (changed) write(APP_ROOT_PATH, source);
  return changed;
}

function patchGlobals() {
  let source = read(GLOBALS_PATH);
  if (source.includes(CSS_MARKER)) return false;

  source += String.raw`

/* ${CSS_MARKER} */
html[data-tepiha-operational-fullscreen="1"],
html[data-tepiha-operational-fullscreen="1"] body,
html[data-tepiha-operational-fullscreen="1"] #root {
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
  overflow-x: hidden !important;
}

html[data-tepiha-operational-fullscreen="1"] [data-tepiha-route-layout="1"] {
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
  box-sizing: border-box !important;
}

html[data-tepiha-operational-fullscreen="1"] [data-tepiha-route-page="1"] {
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  padding-left: max(6px, env(safe-area-inset-left, 0px)) !important;
  padding-right: max(6px, env(safe-area-inset-right, 0px)) !important;
  box-sizing: border-box !important;
}

html[data-tepiha-operational-fullscreen="1"] [data-tepiha-route-wide="1"] {
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  box-sizing: border-box !important;
}

html[data-tepiha-operational-fullscreen="1"] .arka-shell,
html[data-tepiha-operational-fullscreen="1"] .arka-container,
html[data-tepiha-operational-fullscreen="1"] .bonusPage,
html[data-tepiha-operational-fullscreen="1"] .bonusShell,
html[data-tepiha-operational-fullscreen="1"] .wrap {
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  box-sizing: border-box !important;
}

html[data-tepiha-operational-fullscreen="1"] .arka-shell,
html[data-tepiha-operational-fullscreen="1"] .arka-container {
  padding-left: 0 !important;
  padding-right: 0 !important;
}

html[data-tepiha-operational-fullscreen="1"] [data-tepiha-route-page="1"] > [style*="width: min("],
html[data-tepiha-operational-fullscreen="1"] [data-tepiha-route-page="1"] > [style*="width:min("],
html[data-tepiha-operational-fullscreen="1"] [data-tepiha-route-page="1"] > .bonusShell {
  width: 100% !important;
  max-width: none !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
}
`;

  write(GLOBALS_PATH, source);
  return true;
}

const result = {
  appRootChanged: patchAppRoot(),
  globalsChanged: patchGlobals(),
};

console.log('OPERATIONAL_FULLSCREEN_V2', result);
