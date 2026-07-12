const TRACKING_PATH_RE = /^\/k(?:\/|$)/i;

const CUSTOMER_COPY_REPLACEMENTS = [
  ['Ndiqeni progresin e porosisë suaj në kohë reale.', 'Tepihat e juaj – ndiqeni progresin në kohë reale.'],
  ['Po marrim të dhënat e porosisë suaj.', 'Po marrim të dhënat për tepihat e juaj.'],
  ['Nuk u ngarkua porosia', 'Nuk u ngarkuan të dhënat e tepihave'],
  ['ID e porosisë mungon.', 'Linku i tepihave nuk është i plotë.'],
  ['Porosia nuk u gjet.', 'Të dhënat e tepihave nuk u gjetën.'],
  ['Ndodhi një gabim gjatë ngarkimit të porosisë.', 'Ndodhi një gabim gjatë ngarkimit të të dhënave të tepihave.'],
  ['Marrja e Porosisë', 'Marrja e Tepihave'],
  ['Porosia ndodhet në Depo!', 'Tepihat ndodhen në Depo!'],
  ['porosia është kthyer në depo', 'tepihat janë kthyer në depo'],
  ['rikthimin e porosisë', 'risjelljen e tepihave'],
  ['Kjo porosi është anuluar.', 'Ky proces është anuluar.'],
  ['Statusi i Porosisë', 'Statusi i Tepihave'],
  ['Porosia', 'Tepihat'],
  ['porosia', 'tepihat'],
  ['porosisë', 'tepihave'],
  ['porosinë', 'tepihat'],
];

export function rewriteCustomerTrackingText(value) {
  let output = String(value ?? '');
  for (const [from, to] of CUSTOMER_COPY_REPLACEMENTS) {
    if (output.includes(from)) output = output.split(from).join(to);
  }
  return output;
}

function rewriteTextNodes(root) {
  if (!root || typeof document === 'undefined') return 0;

  const NodeFilterRef = globalThis.NodeFilter;
  if (!NodeFilterRef || typeof document.createTreeWalker !== 'function') return 0;

  let changed = 0;
  const walker = document.createTreeWalker(
    root,
    NodeFilterRef.SHOW_TEXT,
    {
      acceptNode(node) {
        const parentTag = String(node?.parentElement?.tagName || '').toUpperCase();
        if (parentTag === 'SCRIPT' || parentTag === 'STYLE' || parentTag === 'NOSCRIPT') {
          return NodeFilterRef.FILTER_REJECT;
        }
        return NodeFilterRef.FILTER_ACCEPT;
      },
    },
  );

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    const before = String(node.nodeValue ?? '');
    const after = rewriteCustomerTrackingText(before);
    if (after === before) continue;
    node.nodeValue = after;
    changed += 1;
  }

  return changed;
}

export function installCustomerTrackingCopyFix() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  if (!TRACKING_PATH_RE.test(String(window.location?.pathname || ''))) return () => {};

  const apply = () => {
    try {
      rewriteTextNodes(document.getElementById('root') || document.body || document.documentElement);
    } catch {}
  };

  apply();

  const Observer = globalThis.MutationObserver;
  if (typeof Observer !== 'function') return () => {};

  const observer = new Observer(() => apply());
  const observeTarget = document.getElementById('root') || document.body || document.documentElement;
  if (observeTarget) {
    observer.observe(observeTarget, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  return () => observer.disconnect();
}

export default {
  rewriteCustomerTrackingText,
  installCustomerTrackingCopyFix,
};
