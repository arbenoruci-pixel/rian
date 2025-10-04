
/* Flow Core v2 — flow-core.js
   - Enforces status flow
   - Permanent client code (NR RENDOR)
   - ARKA integration on payment
*/
(function(){
  const STORE_KEY = 'orders_v1';
  const CLIENTS_KEY = 'clients_v1';
  const CLIENT_SEQ_KEY = 'clients_seq_v1';
  const ARKA_KEY = 'arka_v1';

  const ALLOWED = {
    pranim:     ['pastrim'],
    pastrim:    ['gati'],
    gati:       ['marrje-sot'],
    'marrje-sot': []
  };

  function todayStr() {
    const d = new Date();
    return d.toISOString().slice(0,10);
  }
  function load(k, def){ try{ return JSON.parse(localStorage.getItem(k) || JSON.stringify(def)); }catch(_){ return def; } }
  function save(k, v){ localStorage.setItem(k, JSON.stringify(v)); }
  function findById(list, id){ return list.find(o=>String(o.id)===String(id)); }
  function log(){ console.log.apply(console, ['[FLOW]'].concat([].slice.call(arguments))); }
  function warn(){ console.warn.apply(console, ['[FLOW]'].concat([].slice.call(arguments))); }

  const Clients = {
    all(){ return load(CLIENTS_KEY, []); },
    nextCode(){
      let n = parseInt(localStorage.getItem(CLIENT_SEQ_KEY)||'0',10);
      if (!Number.isFinite(n) || n<1) n=1;
      localStorage.setItem(CLIENT_SEQ_KEY, String(n+1));
      return String(n).padStart(3, '0');
    },
    match(name, phone){
      const list = Clients.all();
      const byPhone = phone && list.find(c => c.phone && String(c.phone).trim() === String(phone).trim());
      if (byPhone) return byPhone;
      const byName = name && list.find(c => c.name && String(c.name).trim().toLowerCase() === String(name).trim().toLowerCase());
      return byName || null;
    },
    ensure(name, phone){
      const hit = Clients.match(name, phone);
      if (hit) return hit;
      const code = Clients.nextCode();
      const rec = { code, name: name||'', phone: phone||'', createdAt: new Date().toISOString() };
      const list = Clients.all();
      list.push(rec);
      save(CLIENTS_KEY, list);
      log('CLIENT_NEW', code, name||'', phone||'');
      return rec;
    }
  };

  const Arka = {
    all(){ return load(ARKA_KEY, []); },
    addPayment({orderId, clientCode, amount, method}){
      const row = {
        id: Date.now(),
        day: todayStr(),
        orderId, clientCode,
        amount: Number(amount||0),
        method: method||'cash',
        createdAt: new Date().toISOString()
      };
      const rows = Arka.all(); rows.push(row); save(ARKA_KEY, rows);
      log('ARKA_ADD', row);
      return row;
    },
    today(){ const t=todayStr(); return Arka.all().filter(r=>r.day===t); }
  };

  const Flow = {
    list(status){ return load(STORE_KEY, []).filter(o=>o.status===status); },
    upsert(order){
      const list = load(STORE_KEY, []);
      const existing = findById(list, order.id);
      if (existing){
        Object.assign(existing, order, {updatedAt: new Date().toISOString()});
        log('UPD', existing.id, '→', existing.status);
      } else {
        order.createdAt = new Date().toISOString();
        order.updatedAt = order.createdAt;
        list.push(order);
        log('NEW', order.id, '→', order.status);
      }
      save(STORE_KEY, list);
      return order;
    },
    get(id){ return findById(load(STORE_KEY, []), id); },
    canGo(from, to){
      const ok = (ALLOWED[from]||[]).includes(to);
      if (!ok) warn('BLOCK', `Illegal transition ${from} → ${to}`);
      return ok;
    },
    move(id, next){
      const list = load(STORE_KEY, []);
      const o = findById(list, id);
      if (!o){ warn('MISS', id, 'not found'); return null; }
      if (!Flow.canGo(o.status, next)) return null;

      o.status = next;
      o.updatedAt = new Date().toISOString();
      if (next==='marrje-sot'){
        o.pickedUpDay = todayStr();
      }
      save(STORE_KEY, list);
      log('MOVE', id, '→', next, {pickedUpDay: o.pickedUpDay||null});
      return o;
    },
    listTodayPicked(){
      const t = todayStr();
      return load(STORE_KEY, []).filter(o=>o.status==='marrje-sot' && o.pickedUpDay===t);
    },
    purgeOldPickups(){
      const t = todayStr();
      const list = load(STORE_KEY, []);
      const keep = list.filter(o => !(o.status==='marrje-sot' && o.pickedUpDay && o.pickedUpDay!==t));
      if (keep.length!==list.length){
        log('PURGE', list.length-keep.length, 'old completed orders');
        save(STORE_KEY, keep);
      }
    },
    // High-level helpers
    createFromPranim({id, name, phone, total, transport}){
      const client = Clients.ensure(name, phone);
      const order = {
        id,
        status: 'pranim',
        clientCode: client.code,
        name, phone,
        total: Number(total||0),
        transport: !!transport
      };
      Flow.upsert(order);
      Flow.move(id, 'pastrim');
      return order;
    },
    markGati(id){
      return Flow.move(id, 'gati');
    },
    markPaidAndDeliver({id, amount, method}){
      const o = Flow.get(id);
      if (!o){ warn('MISS', id, 'cannot pay'); return null; }
      Arka.addPayment({orderId: id, clientCode: o.clientCode, amount: amount||o.total, method});
      return Flow.move(id, 'marrje-sot');
    }
  };

  window.Flow = Flow;
  window.FlowClients = Clients;
  window.Arka = Arka;

  console.log('%cFLOW CORE READY','font-weight:bold;padding:2px 6px;border:1px solid #999;border-radius:4px;');
  Flow.purgeOldPickups();
})();
