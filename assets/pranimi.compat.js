// assets/pranimi.compat.js — tailored to your PRANIMI HTML
import { rpc, insert } from '/assets/supabase.js';

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const txt = s => ($(s)?.value ?? $(s)?.textContent ?? '').toString().trim();
const toNum = (v) => {
  const t = (v ?? '').toString().replace(',', '.').replace(/[^\d.\-]/g,'');
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
};

// ---------- state ----------
const state = {
  tepiha: {},  // size -> count
  staza:  {},  // size -> count
  stairsM2: 0,
  price: 3.0   // default €/m² if no input is present
};

// If you later add a price input, give it id="price_per_m2".
const priceInput = $('#price_per_m2');
if (priceInput) {
  state.price = toNum(priceInput.value);
  priceInput.addEventListener('input', () => {
    state.price = toNum(priceInput.value);
    recalcTotals();
  });
}

// ---------- Supabase code in header ----------
let assignedCode = null;
async function ensureCode(){
  if (assignedCode) return assignedCode;
  const r = await rpc('next_code_num', {});
  const code = Array.isArray(r) ? (r[0]?.next_code || r[0]) : (r?.next_code || r);
  assignedCode = String(code);
  // Your header element is #ticketCode like: "KODI: ——"
  const codeEl = $('#ticketCode') || $('.kodi') || $('[data-code]');
  if (codeEl) codeEl.textContent = 'KODI: ' + assignedCode;
  return assignedCode;
}
ensureCode().catch(console.error);

// ---------- rendering ----------
function renderList(group){
  const list = group === 'tepiha' ? $('#list-tepiha') : $('#list-staza');
  if (!list) return;
  list.innerHTML = '';
  const bag = state[group];
  Object.keys(bag).sort((a,b)=>toNum(a)-toNum(b)).forEach(size => {
    const count = bag[size];
    if (!count) return;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div>${Number(size).toFixed(1)} m²</div>
                     <div>× ${count}</div>`;
    list.appendChild(row);
  });
}

function recalcTotals(){
  // Compute m² and pieces
  let m2_tepiha = 0, m2_staza = 0, pc = 0;
  for (const [s,c] of Object.entries(state.tepiha)) { m2_tepiha += Number(s)*c; pc += c; }
  for (const [s,c] of Object.entries(state.staza))  { m2_staza  += Number(s)*c; pc += c; }
  const m2_total = m2_tepiha + m2_staza + state.stairsM2;

  // Write section totals
  const t1 = $('#tot-tepiha'); if (t1) t1.textContent = `${m2_tepiha.toFixed(2)} m²`;
  const t2 = $('#tot-staza');  if (t2) t2.textContent = `${m2_staza.toFixed(2)} m²`;
  const ts = $('#stairsM2');   if (ts) ts.textContent = `${state.stairsM2.toFixed(2)} m²`;

  // Write summary totals
  const m2T = $('#m2Total');   if (m2T) m2T.textContent = m2_total.toFixed(2);
  const eur = $('#euroTotal'); if (eur) eur.textContent = (m2_total * state.price).toFixed(2);

  renderList('tepiha');
  renderList('staza');

  return { m2: m2_total, pieces: pc, price_per_m2: state.price, total: Number((m2_total*state.price).toFixed(2)) };
}

// ---------- chip handling ----------
function add(group, size){
  const bag = state[group];
  bag[size] = (bag[size] || 0) + 1;
  recalcTotals();
}
function addRow(group, size){
  // if size is null, prompt the user for a value
  let s = size;
  if (s == null) {
    const input = prompt('Vendos m² për rreshtin:', '2.0');
    if (!input) return;
    s = toNum(input);
  }
  if (!s || s <= 0) return;
  add(group, s.toFixed(1));
}
function removeRow(group){
  // Removes the last non-zero size entry
  const bag = state[group];
  const sizes = Object.keys(bag).filter(k=>bag[k]>0).sort((a,b)=>toNum(b)-toNum(a));
  if (!sizes.length) return;
  const k = sizes[0];
  bag[k] = Math.max(0, (bag[k]||0)-1);
  recalcTotals();
}

// Expose for your existing buttons: + Rresht / − Rresht
window.addRow = addRow;
window.removeRow = removeRow;

// Click on chips (buttons with class="chip" inside chips-tepiha/staza)
document.addEventListener('click', (e)=>{
  const chip = e.target.closest('#chips-tepiha .chip, #chips-staza .chip');
  if (!chip) return;
  const label = chip.textContent.trim();
  const group = chip.closest('#chips-tepiha') ? 'tepiha' : 'staza';
  if (/manual/i.test(label)) {
    addRow(group, null);
  } else {
    const size = toNum(label);
    if (size > 0) add(group, size.toFixed(1));
  }
});

// ---------- stairs handling (0.3 m² per step) ----------
const stairsBtn = document.getElementById('openStairs');
if (stairsBtn) {
  stairsBtn.addEventListener('click', ()=>{
    const n = Number(prompt('Numri i shkallëve (0.3 m² secila):', '1')) || 0;
    if (n > 0) {
      state.stairsM2 += n * 0.3;
      recalcTotals();
    }
  });
}

// ---------- save ----------
async function save(){
  const code  = await ensureCode();
  const name  = txt('#name');
  const phone = (txt('#phonePrefix') + txt('#phone')).replace(/\s+/g,'');
  const note  = txt('#note,#shenimi,#shënimi');
  const { m2, pieces, price_per_m2, total } = recalcTotals();
  const now = new Date().toISOString();

  await insert('orders', {
    code, name, phone, note,
    m2, pieces, price_per_m2, total,
    status: 'pastrim',
    created_at: now,
    updated_at: now,
    no_show: false
  });

  location.href = '/pastrimi/';
}

// Intercept the VAZHDO link/button (#btnContinue)
const cont = document.getElementById('btnContinue');
if (cont) {
  cont.addEventListener('click', (e)=>{
    e.preventDefault();
    save().catch(err => alert('Nuk u ruajt (PRANIMI)\n' + (err.message || err)));
  });
}

// Initial render
recalcTotals();
