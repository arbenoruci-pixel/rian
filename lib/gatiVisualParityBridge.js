const STYLE_ID = 'tepiha-gati-visual-parity-v1';
const ROOT_CLASS = 'tepiha-gati-visual-parity-v1';

let installed = false;
let observer = null;
let intervalId = null;
let scheduled = false;

function isGatiPath() {
  try {
    const path = String(window.location?.pathname || '').replace(/\/+$/, '') || '/';
    return path === '/gati';
  } catch {
    return false;
  }
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    html.${ROOT_CLASS},
    html.${ROOT_CLASS} body,
    html.${ROOT_CLASS} #root {
      width: 100% !important;
      max-width: 100% !important;
      overflow-x: hidden !important;
    }

    html.${ROOT_CLASS} #root .wrap {
      width: 100% !important;
      max-width: 760px !important;
      margin: 0 auto !important;
      padding-top: max(8px, env(safe-area-inset-top, 8px)) !important;
      padding-right: max(5px, env(safe-area-inset-right, 0px)) !important;
      padding-bottom: calc(88px + env(safe-area-inset-bottom, 0px)) !important;
      padding-left: max(5px, env(safe-area-inset-left, 0px)) !important;
      box-sizing: border-box !important;
    }

    html.${ROOT_CLASS} #root [data-gati-header="1"] {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) auto !important;
      align-items: start !important;
      gap: 8px !important;
      margin: 0 1px 9px !important;
      padding: 0 !important;
    }

    html.${ROOT_CLASS} #root [data-gati-header="1"] .title {
      margin: 0 !important;
      font-size: clamp(27px, 7vw, 34px) !important;
      line-height: 1 !important;
      letter-spacing: .025em !important;
      font-weight: 1000 !important;
    }

    html.${ROOT_CLASS} #root [data-gati-header="1"] .subtitle {
      margin-top: 7px !important;
      max-width: 230px !important;
      font-size: 12px !important;
      line-height: 1.22 !important;
      letter-spacing: .04em !important;
      font-weight: 850 !important;
      color: rgba(226,232,240,.68) !important;
      text-transform: uppercase !important;
    }

    html.${ROOT_CLASS} #root [data-gati-header-right="1"] {
      display: grid !important;
      justify-items: end !important;
      gap: 6px !important;
      min-width: 0 !important;
      font-size: 10.5px !important;
    }

    html.${ROOT_CLASS} #root [data-gati-total-pill="1"] {
      min-width: 132px !important;
      padding: 7px 9px !important;
      border: 1px solid rgba(34,197,94,.26) !important;
      border-radius: 12px !important;
      background: linear-gradient(180deg, rgba(6,78,59,.34), rgba(15,23,42,.74)) !important;
      color: rgba(226,232,240,.78) !important;
      text-align: right !important;
      line-height: 1.05 !important;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.025) !important;
    }

    html.${ROOT_CLASS} #root [data-gati-total-pill="1"] strong {
      display: inline-block !important;
      margin-left: 4px !important;
      font-size: 15px !important;
      color: #4ade80 !important;
      font-weight: 1000 !important;
    }

    html.${ROOT_CLASS} #root [data-gati-header-actions="1"] {
      display: grid !important;
      grid-template-columns: repeat(2, minmax(0, auto)) !important;
      gap: 5px !important;
      justify-content: end !important;
      width: auto !important;
    }

    html.${ROOT_CLASS} #root [data-gati-header-actions="1"] button {
      min-height: 36px !important;
      padding: 7px 9px !important;
      border-radius: 10px !important;
      font-size: 9.5px !important;
      line-height: 1.02 !important;
      white-space: nowrap !important;
      touch-action: manipulation !important;
      -webkit-tap-highlight-color: transparent !important;
    }

    html.${ROOT_CLASS} #root [data-gati-search="1"] {
      display: block !important;
      width: 100% !important;
      max-width: none !important;
      min-width: 0 !important;
      min-height: 50px !important;
      margin: 0 0 8px !important;
      padding: 11px 13px !important;
      border-radius: 14px !important;
      border: 1px solid rgba(59,130,246,.30) !important;
      background: rgba(2,6,23,.74) !important;
      color: #f8fafc !important;
      font-size: 15px !important;
      font-weight: 800 !important;
      box-sizing: border-box !important;
    }

    html.${ROOT_CLASS} #root [data-gati-list-container="1"] {
      display: flex !important;
      flex-direction: column !important;
      gap: 6px !important;
      width: 100% !important;
      max-width: none !important;
      margin: 0 !important;
      padding: 4px !important;
      border: 1px solid rgba(59,130,246,.16) !important;
      border-radius: 16px !important;
      background: linear-gradient(180deg, rgba(15,23,42,.86), rgba(2,6,23,.88)) !important;
      overflow: hidden !important;
      box-sizing: border-box !important;
    }

    html.${ROOT_CLASS} #root [data-gati-card="1"] {
      position: relative !important;
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) auto !important;
      align-items: center !important;
      gap: 8px !important;
      width: 100% !important;
      min-width: 0 !important;
      min-height: 104px !important;
      margin: 0 !important;
      padding: 10px 8px 10px 9px !important;
      border: 1px solid rgba(96,165,250,.15) !important;
      border-left: 5px solid #f59e0b !important;
      border-radius: 14px !important;
      background: linear-gradient(100deg, rgba(30,41,85,.96), rgba(15,23,42,.94)) !important;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.02), 0 4px 14px rgba(0,0,0,.13) !important;
      overflow: hidden !important;
      box-sizing: border-box !important;
    }

    html.${ROOT_CLASS} #root [data-gati-main="1"] {
      display: flex !important;
      align-items: center !important;
      gap: 10px !important;
      min-width: 0 !important;
      flex: 1 1 auto !important;
    }

    html.${ROOT_CLASS} #root [data-gati-code-column="1"] {
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      gap: 4px !important;
      flex: 0 0 auto !important;
    }

    html.${ROOT_CLASS} #root [data-gati-code-column="1"] > div:first-child {
      width: 52px !important;
      height: 52px !important;
      border-radius: 12px !important;
      font-size: 17px !important;
      line-height: 1 !important;
      font-weight: 1000 !important;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.16) !important;
      touch-action: manipulation !important;
    }

    html.${ROOT_CLASS} #root [data-gati-info="1"] {
      min-width: 0 !important;
      flex: 1 1 auto !important;
    }

    html.${ROOT_CLASS} #root [data-gati-info="1"] > div:first-child {
      font-size: clamp(16px, 4.4vw, 19px) !important;
      line-height: 1.08 !important;
      font-weight: 1000 !important;
      color: #f8fafc !important;
      letter-spacing: -.015em !important;
    }

    html.${ROOT_CLASS} #root [data-gati-info="1"] > div:nth-child(2) {
      margin-top: 3px !important;
      font-size: 12px !important;
      line-height: 1.05 !important;
      color: rgba(226,232,240,.72) !important;
      font-weight: 750 !important;
    }

    html.${ROOT_CLASS} #root [data-gati-info="1"] > div:nth-child(3) {
      margin-top: 3px !important;
      font-size: 10px !important;
      line-height: 1 !important;
      color: rgba(226,232,240,.47) !important;
      font-weight: 800 !important;
    }

    html.${ROOT_CLASS} #root [data-gati-info="1"] button {
      margin-top: 4px !important;
      font-size: 10.5px !important;
      line-height: 1.12 !important;
      max-width: 100% !important;
    }

    html.${ROOT_CLASS} #root [data-gati-info="1"] span {
      font-size: 9px !important;
      line-height: 1 !important;
      padding: 3px 7px !important;
    }

    html.${ROOT_CLASS} #root [data-gati-actions="1"] {
      display: grid !important;
      grid-template-columns: 1fr !important;
      align-items: stretch !important;
      gap: 7px !important;
      width: 112px !important;
      min-width: 112px !important;
      flex: 0 0 112px !important;
    }

    html.${ROOT_CLASS} #root [data-gati-actions="1"] > span {
      display: none !important;
    }

    html.${ROOT_CLASS} #root [data-gati-actions="1"] .btn {
      width: 100% !important;
      min-width: 0 !important;
      min-height: 42px !important;
      margin: 0 !important;
      padding: 8px 9px !important;
      border-radius: 999px !important;
      font-size: 11px !important;
      line-height: 1 !important;
      font-weight: 1000 !important;
      letter-spacing: .015em !important;
      white-space: nowrap !important;
      touch-action: manipulation !important;
      -webkit-tap-highlight-color: transparent !important;
    }

    html.${ROOT_CLASS} #root [data-gati-actions="1"] .btn.secondary {
      border-color: rgba(96,165,250,.28) !important;
      background: rgba(2,6,23,.70) !important;
      color: #f8fafc !important;
    }

    html.${ROOT_CLASS} #root [data-gati-actions="1"] .btn.primary {
      border-color: rgba(37,99,235,.92) !important;
      background: linear-gradient(180deg, #1673ff, #0758e8) !important;
      color: #fff !important;
      box-shadow: 0 5px 16px rgba(37,99,235,.22) !important;
    }

    @media (max-width: 430px) {
      html.${ROOT_CLASS} #root .wrap {
        padding-right: max(4px, env(safe-area-inset-right, 0px)) !important;
        padding-left: max(4px, env(safe-area-inset-left, 0px)) !important;
      }

      html.${ROOT_CLASS} #root [data-gati-header="1"] {
        gap: 5px !important;
      }

      html.${ROOT_CLASS} #root [data-gati-total-pill="1"] {
        min-width: 118px !important;
        padding: 6px 7px !important;
        font-size: 9.5px !important;
      }

      html.${ROOT_CLASS} #root [data-gati-header-actions="1"] {
        gap: 4px !important;
      }

      html.${ROOT_CLASS} #root [data-gati-header-actions="1"] button {
        min-height: 34px !important;
        padding: 6px 7px !important;
        font-size: 8.8px !important;
      }

      html.${ROOT_CLASS} #root [data-gati-card="1"] {
        grid-template-columns: minmax(0, 1fr) 104px !important;
        gap: 5px !important;
        min-height: 100px !important;
        padding: 9px 6px 9px 7px !important;
      }

      html.${ROOT_CLASS} #root [data-gati-main="1"] {
        gap: 8px !important;
      }

      html.${ROOT_CLASS} #root [data-gati-code-column="1"] > div:first-child {
        width: 48px !important;
        height: 48px !important;
        border-radius: 11px !important;
        font-size: 15px !important;
      }

      html.${ROOT_CLASS} #root [data-gati-actions="1"] {
        width: 104px !important;
        min-width: 104px !important;
        flex-basis: 104px !important;
        gap: 6px !important;
      }

      html.${ROOT_CLASS} #root [data-gati-actions="1"] .btn {
        min-height: 39px !important;
        padding: 7px 6px !important;
        font-size: 10px !important;
      }
    }
  `;
  document.head.appendChild(style);
}

function getCards() {
  try {
    return Array.from(document.querySelectorAll('#root .list-item-compact'));
  } catch {
    return [];
  }
}

function clearDecorations() {
  try { document.documentElement.classList.remove(ROOT_CLASS); } catch {}
  getCards().forEach((card) => {
    try {
      card.removeAttribute('data-gati-card');
      const main = card.children?.[0];
      const actions = card.children?.[1];
      main?.removeAttribute?.('data-gati-main');
      actions?.removeAttribute?.('data-gati-actions');
      main?.children?.[0]?.removeAttribute?.('data-gati-code-column');
      main?.children?.[1]?.removeAttribute?.('data-gati-info');
      card.parentElement?.removeAttribute?.('data-gati-list-container');
    } catch {}
  });
  try {
    const header = document.querySelector('#root .wrap > .header-row');
    header?.removeAttribute?.('data-gati-header');
    header?.children?.[1]?.removeAttribute?.('data-gati-header-right');
    header?.children?.[1]?.children?.[0]?.removeAttribute?.('data-gati-total-pill');
    header?.children?.[1]?.children?.[1]?.removeAttribute?.('data-gati-header-actions');
    document.querySelectorAll('#root input[data-gati-search="1"]').forEach((input) => input.removeAttribute('data-gati-search'));
  } catch {}
}

function applyVisualParity() {
  if (!isGatiPath()) {
    clearDecorations();
    return;
  }

  ensureStyle();
  try { document.documentElement.classList.add(ROOT_CLASS); } catch {}

  try {
    const header = document.querySelector('#root .wrap > .header-row');
    if (header) {
      header.dataset.gatiHeader = '1';
      const right = header.children?.[1];
      if (right) {
        right.dataset.gatiHeaderRight = '1';
        if (right.children?.[0]) right.children[0].dataset.gatiTotalPill = '1';
        if (right.children?.[1]) right.children[1].dataset.gatiHeaderActions = '1';
      }
    }
  } catch {}

  try {
    const search = Array.from(document.querySelectorAll('#root input.input')).find((input) => /k[eë]rko/i.test(String(input?.placeholder || '')));
    if (search) search.dataset.gatiSearch = '1';
  } catch {}

  const cards = getCards();
  const parents = new Set();
  cards.forEach((card) => {
    try {
      card.dataset.gatiCard = '1';
      const main = card.children?.[0];
      const actions = card.children?.[1];
      if (main) {
        main.dataset.gatiMain = '1';
        if (main.children?.[0]) main.children[0].dataset.gatiCodeColumn = '1';
        if (main.children?.[1]) main.children[1].dataset.gatiInfo = '1';
      }
      if (actions) actions.dataset.gatiActions = '1';
      if (card.parentElement) parents.add(card.parentElement);
    } catch {}
  });

  parents.forEach((parent) => {
    try { parent.dataset.gatiListContainer = '1'; } catch {}
  });
}

function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    try { applyVisualParity(); } catch {}
  };
  try { window.requestAnimationFrame(run); } catch { window.setTimeout(run, 0); }
}

export function installGatiVisualParityBridge() {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return;
  installed = true;
  ensureStyle();

  try {
    observer = new MutationObserver(() => scheduleApply());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    observer = null;
  }

  try { window.addEventListener('popstate', scheduleApply, { passive: true }); } catch {}
  try { window.addEventListener('tepiha:route-ui-alive', scheduleApply, { passive: true }); } catch {}
  try { window.addEventListener('tepiha:first-ui-ready', scheduleApply, { passive: true }); } catch {}
  try { window.addEventListener('pageshow', scheduleApply, { passive: true }); } catch {}
  try { intervalId = window.setInterval(scheduleApply, 900); } catch { intervalId = null; }
  try { window.__TEPIHA_GATI_VISUAL_PARITY__ = { version: 'v1', scheduleApply }; } catch {}
  scheduleApply();
}
