const TOOLBAR_ID = 'tepiha-pastrimi-worker-toolbar-v1';
const STYLE_ID = 'tepiha-pastrimi-worker-style-v2';
const LEGACY_STYLE_ID = 'tepiha-pastrimi-worker-style-v1';
const FILTER_KEY = 'tepiha_pastrimi_worker_filter_v1';

const GROUPS = {
  all: { label: 'TE GJITHA', order: 0 },
  blerim: { label: 'BLERIM', order: 100 },
  tapin: { label: 'TAPIN', order: 200 },
  baza: { label: 'BAZA', order: 300 },
};

let activeFilter = 'all';
let observer = null;
let intervalId = null;
let scheduled = false;
let installed = false;

function isPastrimiPath() {
  try {
    const path = String(window.location?.pathname || '').replace(/\/+$/, '') || '/';
    return path === '/pastrimi';
  } catch {
    return false;
  }
}

function readFilter() {
  try {
    const value = String(window.localStorage?.getItem(FILTER_KEY) || 'all').trim().toLowerCase();
    return GROUPS[value] ? value : 'all';
  } catch {
    return 'all';
  }
}

function saveFilter(value) {
  try { window.localStorage?.setItem(FILTER_KEY, value); } catch {}
}

function ensureStyle() {
  try { document.getElementById(LEGACY_STYLE_ID)?.remove(); } catch {}
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    html.tepiha-pastrimi-worker-toolbar-active,
    html.tepiha-pastrimi-worker-toolbar-active body {
      width: 100% !important;
      max-width: 100% !important;
      overflow-x: hidden !important;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root {
      width: 100% !important;
      max-width: none !important;
      overflow-x: hidden !important;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root .wrap {
      width: 100% !important;
      max-width: 760px !important;
      margin: 0 auto !important;
      padding-top: calc(61px + env(safe-area-inset-top, 0px)) !important;
      padding-right: max(6px, env(safe-area-inset-right, 0px)) !important;
      padding-bottom: calc(88px + env(safe-area-inset-bottom, 0px)) !important;
      padding-left: max(6px, env(safe-area-inset-left, 0px)) !important;
      box-sizing: border-box !important;
    }

    #${TOOLBAR_ID} {
      position: fixed;
      z-index: 2147482000;
      top: max(4px, env(safe-area-inset-top, 4px));
      left: 50%;
      transform: translateX(-50%);
      width: min(760px, calc(100vw - 8px));
      display: grid;
      grid-template-columns: 1.18fr repeat(3, minmax(0, 1fr));
      gap: 4px;
      padding: 4px;
      box-sizing: border-box;
      border-radius: 13px;
      border: 1px solid rgba(148,163,184,.28);
      background: rgba(2,6,23,.96);
      box-shadow: 0 10px 30px rgba(0,0,0,.50);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;
    }

    #${TOOLBAR_ID} button {
      min-width: 0;
      min-height: 40px;
      border-radius: 9px;
      padding: 4px 2px;
      border: 1px solid rgba(148,163,184,.22);
      background: rgba(15,23,42,.84);
      color: rgba(226,232,240,.84);
      font-size: 10px;
      line-height: 1.05;
      font-weight: 1000;
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }

    #${TOOLBAR_ID} button [data-role="count"] {
      margin-top: 2px !important;
      font-size: 8.2px !important;
      line-height: 1 !important;
    }

    #${TOOLBAR_ID} button[data-filter="blerim"] { color: #bae6fd; }
    #${TOOLBAR_ID} button[data-filter="tapin"] { color: #e9d5ff; }
    #${TOOLBAR_ID} button[data-filter="baza"] { color: #bbf7d0; }
    #${TOOLBAR_ID} button[data-active="1"][data-filter="all"] {
      background: rgba(71,85,105,.76); border-color: rgba(203,213,225,.74); color: #fff;
    }
    #${TOOLBAR_ID} button[data-active="1"][data-filter="blerim"] {
      background: rgba(2,132,199,.40); border-color: rgba(56,189,248,.90); color: #fff;
    }
    #${TOOLBAR_ID} button[data-active="1"][data-filter="tapin"] {
      background: rgba(126,34,206,.40); border-color: rgba(192,132,252,.90); color: #fff;
    }
    #${TOOLBAR_ID} button[data-active="1"][data-filter="baza"] {
      background: rgba(22,101,52,.44); border-color: rgba(74,222,128,.90); color: #fff;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root .wrap > .header-row {
      gap: 6px !important;
      margin-bottom: 7px !important;
      padding: 0 1px !important;
      flex-wrap: nowrap !important;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root .wrap > .header-row .title {
      font-size: clamp(21px, 6vw, 27px) !important;
      line-height: 1 !important;
      letter-spacing: .035em !important;
      white-space: nowrap !important;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root .wrap > .header-row button {
      min-height: 38px !important;
      padding: 7px 10px !important;
      border-radius: 11px !important;
      font-size: 10.5px !important;
      line-height: 1.05 !important;
      white-space: nowrap !important;
      touch-action: manipulation !important;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root .cap-card {
      margin-bottom: 7px !important;
      padding: 9px 11px !important;
      border-radius: 14px !important;
      min-height: 0 !important;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root .cap-title {
      margin: 0 !important;
      font-size: 10px !important;
      line-height: 1.05 !important;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root .cap-value {
      margin: 3px 0 4px !important;
      font-size: clamp(34px, 10vw, 45px) !important;
      line-height: .98 !important;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root .cap-bar {
      height: 8px !important;
      margin: 4px 0 !important;
      border-radius: 999px !important;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root .cap-row {
      margin-top: 3px !important;
      font-size: 10px !important;
      line-height: 1 !important;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root input.input[placeholder*="Kërko"],
    html.tepiha-pastrimi-worker-toolbar-active #root input.input[placeholder*="Kerko"] {
      display: block !important;
      width: 100% !important;
      max-width: none !important;
      min-width: 0 !important;
      margin: 0 0 6px !important;
      padding: 10px 11px !important;
      border-radius: 12px !important;
      font-size: 14px !important;
      line-height: 1.2 !important;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root input.input[placeholder*="Kërko"] + div,
    html.tepiha-pastrimi-worker-toolbar-active #root input.input[placeholder*="Kerko"] + div {
      display: flex !important;
      flex-wrap: nowrap !important;
      gap: 5px !important;
      width: 100% !important;
      max-width: 100% !important;
      margin: 0 0 7px !important;
      padding: 0 1px 2px !important;
      overflow-x: auto !important;
      overscroll-behavior-x: contain !important;
      scrollbar-width: none !important;
      -webkit-overflow-scrolling: touch !important;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root input.input[placeholder*="Kërko"] + div::-webkit-scrollbar,
    html.tepiha-pastrimi-worker-toolbar-active #root input.input[placeholder*="Kerko"] + div::-webkit-scrollbar {
      display: none !important;
    }

    html.tepiha-pastrimi-worker-toolbar-active #root input.input[placeholder*="Kërko"] + div > button,
    html.tepiha-pastrimi-worker-toolbar-active #root input.input[placeholder*="Kerko"] + div > button {
      flex: 0 0 auto !important;
      min-height: 35px !important;
      padding: 6px 10px !important;
      font-size: 10.5px !important;
      line-height: 1 !important;
      touch-action: manipulation !important;
    }

    #root [data-pastrimi-list-container="1"] {
      display: flex !important;
      flex-direction: column !important;
      width: 100% !important;
      max-width: none !important;
      margin: 0 !important;
      padding: 4px !important;
      border-radius: 14px !important;
      overflow: hidden !important;
    }

    #root .list-item-compact[data-pastrimi-worker-group] {
      position: relative !important;
      width: 100% !important;
      max-width: none !important;
      min-width: 0 !important;
      box-sizing: border-box !important;
      padding: 23px 6px 7px 7px !important;
      margin: 0 0 5px !important;
      border-radius: 11px !important;
      border-bottom: 1px solid rgba(255,255,255,.10) !important;
      overflow: hidden !important;
      gap: 5px !important;
    }

    #root .list-item-compact[data-pastrimi-worker-group]:last-child {
      margin-bottom: 0 !important;
    }

    #root .list-item-compact[data-pastrimi-group-first="1"] {
      margin-top: 7px !important;
    }

    #root .list-item-compact[data-pastrimi-worker-group]::before {
      position: absolute;
      top: 4px;
      right: 6px;
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 8.5px;
      line-height: 1.05;
      font-weight: 1000;
      letter-spacing: .055em;
    }

    #root .list-item-compact[data-pastrimi-worker-group] > div:first-child {
      gap: 7px !important;
      min-width: 0 !important;
    }

    #root .list-item-compact[data-pastrimi-worker-group] > div:first-child > div:first-child {
      gap: 2px !important;
    }

    #root .list-item-compact[data-pastrimi-worker-group] > div:first-child > div:first-child > div:first-child {
      width: 38px !important;
      height: 38px !important;
      border-radius: 8px !important;
      font-size: 13px !important;
    }

    #root .list-item-compact[data-pastrimi-worker-group] .btn {
      flex: 0 0 auto !important;
      min-width: 0 !important;
      min-height: 35px !important;
      padding: 7px 9px !important;
      font-size: 9.5px !important;
      line-height: 1 !important;
      touch-action: manipulation !important;
    }

    #root .list-item-compact[data-pastrimi-worker-group="blerim"] {
      border-left: 5px solid #38bdf8 !important;
      background: linear-gradient(90deg, rgba(2,132,199,.22), rgba(15,23,42,.36)) !important;
      box-shadow: inset 0 0 0 1px rgba(56,189,248,.14);
    }
    #root .list-item-compact[data-pastrimi-worker-group="blerim"]::before {
      content: 'BLERIM'; color: #e0f2fe; border: 1px solid rgba(56,189,248,.58); background: rgba(2,132,199,.40);
    }
    #root .list-item-compact[data-pastrimi-worker-group="tapin"] {
      border-left: 5px solid #c084fc !important;
      background: linear-gradient(90deg, rgba(126,34,206,.22), rgba(15,23,42,.36)) !important;
      box-shadow: inset 0 0 0 1px rgba(192,132,252,.14);
    }
    #root .list-item-compact[data-pastrimi-worker-group="tapin"]::before {
      content: 'TAPIN'; color: #f3e8ff; border: 1px solid rgba(192,132,252,.58); background: rgba(126,34,206,.40);
    }
    #root .list-item-compact[data-pastrimi-worker-group="baza"] {
      border-left: 5px solid #4ade80 !important;
      background: linear-gradient(90deg, rgba(22,101,52,.18), rgba(15,23,42,.32)) !important;
      box-shadow: inset 0 0 0 1px rgba(74,222,128,.11);
    }
    #root .list-item-compact[data-pastrimi-worker-group="baza"]::before {
      content: 'BAZA'; color: #dcfce7; border: 1px solid rgba(74,222,128,.52); background: rgba(22,101,52,.42);
    }
    #root .list-item-compact[data-pastrimi-worker-group="blerim"] > div:first-child > div:first-child > div:first-child {
      background: #0284c7 !important;
    }
    #root .list-item-compact[data-pastrimi-worker-group="tapin"] > div:first-child > div:first-child > div:first-child {
      background: #7e22ce !important;
    }
    #root .list-item-compact[data-pastrimi-worker-group="baza"] > div:first-child > div:first-child > div:first-child {
      background: #15803d !important;
    }

    @media (max-width: 520px) {
      html.tepiha-pastrimi-worker-toolbar-active #root .wrap {
        max-width: none !important;
        padding-right: max(4px, env(safe-area-inset-right, 0px)) !important;
        padding-left: max(4px, env(safe-area-inset-left, 0px)) !important;
      }

      #${TOOLBAR_ID} {
        width: calc(100vw - 6px);
        gap: 3px;
        padding: 3px;
      }

      #${TOOLBAR_ID} button {
        min-height: 39px;
        font-size: 9.5px;
      }

      html.tepiha-pastrimi-worker-toolbar-active #root .wrap > .header-row button {
        padding-left: 8px !important;
        padding-right: 8px !important;
        font-size: 10px !important;
      }

      #root [data-pastrimi-list-container="1"] {
        padding: 3px !important;
      }

      #root .list-item-compact[data-pastrimi-worker-group] {
        padding-left: 6px !important;
        padding-right: 5px !important;
      }
    }
  `;
  document.head.appendChild(style);
}

function detectGroup(card) {
  const text = String(card?.innerText || card?.textContent || '').toUpperCase();
  const markerIndex = text.indexOf('E SOLLI:');
  if (markerIndex >= 0) {
    const after = text.slice(markerIndex + 'E SOLLI:'.length);
    const broughtBy = after.split('📍')[0].split('PAKETO')[0].slice(0, 90);
    if (broughtBy.includes('BLERIM') || broughtBy.includes('KOSUMI') || broughtBy.includes('BELI')) return 'blerim';
    if (broughtBy.includes('TAPIN') || broughtBy.includes('LEPAJA')) return 'tapin';
  }
  return 'baza';
}

function getCards() {
  try {
    return Array.from(document.querySelectorAll('#root .list-item-compact'));
  } catch {
    return [];
  }
}

function ensureToolbar(counts) {
  let toolbar = document.getElementById(TOOLBAR_ID);
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Filtro porosite ne pastrim sipas punetorit');
    Object.entries(GROUPS).forEach(([key, cfg]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.filter = key;
      button.addEventListener('click', () => {
        activeFilter = key;
        saveFilter(key);
        scheduleApply();
      });
      const label = document.createElement('span');
      label.dataset.role = 'label';
      label.textContent = cfg.label;
      const count = document.createElement('span');
      count.dataset.role = 'count';
      count.style.display = 'block';
      button.append(label, count);
      toolbar.appendChild(button);
    });
    document.body.appendChild(toolbar);
  }

  toolbar.querySelectorAll('button[data-filter]').forEach((button) => {
    const key = String(button.dataset.filter || 'all');
    button.dataset.active = activeFilter === key ? '1' : '0';
    button.setAttribute('aria-pressed', activeFilter === key ? 'true' : 'false');
    const count = button.querySelector('[data-role="count"]');
    if (count) count.textContent = `${Number(counts?.[key] || 0)} POROSI`;
  });
}

function clearPageDecorations() {
  try { document.documentElement.classList.remove('tepiha-pastrimi-worker-toolbar-active'); } catch {}
  try { document.getElementById(TOOLBAR_ID)?.remove(); } catch {}
  getCards().forEach((card) => {
    try {
      card.removeAttribute('data-pastrimi-worker-group');
      card.removeAttribute('data-pastrimi-group-first');
      card.removeAttribute('aria-hidden');
      card.style.removeProperty('order');
      card.style.removeProperty('display');
      if (card.parentElement) card.parentElement.removeAttribute('data-pastrimi-list-container');
    } catch {}
  });
}

function applyGrouping() {
  if (!isPastrimiPath()) {
    clearPageDecorations();
    return;
  }

  ensureStyle();
  try { document.documentElement.classList.add('tepiha-pastrimi-worker-toolbar-active'); } catch {}

  const cards = getCards();
  const counts = { all: cards.length, blerim: 0, tapin: 0, baza: 0 };
  const firstSeen = new Set();
  const parents = new Set();

  cards.forEach((card) => {
    const group = detectGroup(card);
    const cfg = GROUPS[group] || GROUPS.baza;
    counts[group] += 1;
    card.dataset.pastrimiWorkerGroup = group;
    card.style.setProperty('order', String(cfg.order), 'important');
    card.setAttribute('aria-hidden', activeFilter !== 'all' && activeFilter !== group ? 'true' : 'false');
    if (activeFilter !== 'all' && activeFilter !== group) card.style.setProperty('display', 'none', 'important');
    else card.style.setProperty('display', 'flex', 'important');

    if (!firstSeen.has(group)) {
      card.dataset.pastrimiGroupFirst = '1';
      firstSeen.add(group);
    } else {
      card.removeAttribute('data-pastrimi-group-first');
    }

    if (card.parentElement) parents.add(card.parentElement);
  });

  parents.forEach((parent) => {
    try {
      parent.dataset.pastrimiListContainer = '1';
      parent.style.setProperty('display', 'flex');
      parent.style.setProperty('flex-direction', 'column');
    } catch {}
  });

  ensureToolbar(counts);
}

function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    try { applyGrouping(); } catch {}
  };
  try { window.requestAnimationFrame(run); } catch { window.setTimeout(run, 0); }
}

export function installPastrimiWorkerGroupingBridge() {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return;
  installed = true;
  activeFilter = readFilter();
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
  try { intervalId = window.setInterval(scheduleApply, 900); } catch { intervalId = null; }
  try { window.__TEPIHA_PASTRIMI_WORKER_GROUPING__ = { version: 'v2-fullscreen', scheduleApply }; } catch {}
  scheduleApply();
}
