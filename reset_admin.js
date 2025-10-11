
/*! reset_admin.js v1.0 — PIN‑protected reset + callable API + optional floating widget */
(function(){
  if (window.__RESET_ADMIN__) return; window.__RESET_ADMIN__ = true;

  // ===== Configuration =====
  var CFG_LOCAL_KEY = 'reset_admin_cfg_v1';

  function loadCfg(){
    try{ return JSON.parse(localStorage.getItem(CFG_LOCAL_KEY)||'{}') || {}; }catch(_){ return {}; }
  }
  function saveCfg(cfg){
    try{ localStorage.setItem(CFG_LOCAL_KEY, JSON.stringify(cfg||{})); }catch(_){}
  }

  // ===== Supabase client helper (reuses your page config) =====
  function supaClient(){
    try{
      if (window.sb) return window.sb;
      if (window.supabase && window.CFG && CFG.supabase && CFG.supabase.url && CFG.supabase.anonKey){
        return window.supabase.createClient(CFG.supabase.url, CFG.supabase.anonKey);
      }
    }catch(_){}
    return null;
  }

  async function wipeSupabaseCodes(){
    try{
      var sb = supaClient();
      if (!sb || !window.CFG || !CFG.supabase || !CFG.supabase.bucket) return { cloud:false, removed:0 };
      var r = await sb.storage.from(CFG.supabase.bucket).list('codes',{limit:10000});
      var list = (r && r.data) || [];
      if(list.length){
        await sb.storage.from(CFG.supabase.bucket).remove(list.map(function(f){return 'codes/'+f.name;}));
      }
      return { cloud:true, removed:list.length };
    }catch(e){
      return { cloud:true, error: (e && (e.message||e)) || 'error' };
    }
  }

  function wipeLocal(){
    var removedMeta=0;
    try{ localStorage.removeItem('client_code_counter'); }catch(_){}
    try{
      var keys=[]; for (var i=0;i<localStorage.length;i++){ keys.push(localStorage.key(i)||''); }
      keys.forEach(function(k){
        if(/^order_meta_/.test(k)){
          try{
            var v=JSON.parse(localStorage.getItem(k)||'{}')||{};
            if(v && v.code){ delete v.code; localStorage.setItem(k, JSON.stringify(v)); removedMeta++; }
          }catch(_){}
        }
      });
    }catch(_){}
    return { removedMeta: removedMeta };
  }

  async function reissue(){
    try{
      if (typeof forceNewDashCode === 'function'){ await forceNewDashCode(); return true; }
      if (typeof reserveDashCode === 'function' && typeof displayCode === 'function'){ displayCode(await reserveDashCode()); return true; }
      var b=document.getElementById('ticketCode'); if(b){ b.textContent='KODI: -1'; return true; }
    }catch(_){}
    return false;
  }

  async function doReset(){
    var local = wipeLocal();
    var cloud = await wipeSupabaseCodes();
    var re = await reissue();
    return { ok:true, local:local, cloud:cloud, reissued:re };
  }

  // ===== Public API =====
  // Call from anywhere: await resetAdmin.reset({pin:'1234', confirm:true})
  // Also: await resetAdmin.clearLocal(), resetAdmin.clearCloud(), resetAdmin.reissue()
  var api = {
    reset: async function(opts){
      opts = opts || {};
      var cfg = loadCfg();
      if (cfg.pin && String(cfg.pin).length){
        var supplied = (opts.pin!=null) ? String(opts.pin) : null;
        if (supplied==null){
          if (typeof prompt==='function'){ supplied = prompt('PIN (4+ shifra):'); }
        }
        if (String(supplied) !== String(cfg.pin)){ return { ok:false, error:'bad_pin' }; }
      }
      if (opts.confirm && typeof confirm==='function'){
        if (!confirm('Reseton kodet? Do të fillojë nga -1.')) return { ok:false, canceled:true };
      }
      return await doReset();
    },
    setPin: function(pin){
      var cfg = loadCfg(); cfg.pin = String(pin||''); saveCfg(cfg); return true;
    },
    getPin: function(){ var cfg=loadCfg(); return cfg.pin||''; },
    clearPin: function(){ var cfg=loadCfg(); delete cfg.pin; saveCfg(cfg); return true; },
    clearLocal: function(){ return wipeLocal(); },
    clearCloud: function(){ return wipeSupabaseCodes(); },
    reissue: function(){ return reissue(); },
    version: '1.0'
  };
  window.resetAdmin = api;

  // ===== Optional floating widget =====
  // Use: resetAdmin.attachWidget({pin:'1234'})  — shows a small ⚙️ button bottom-right.
  // Triple tap widget -> prompt, then action sheet.
  api.attachWidget = function(opts){
    opts = opts || {};
    if (document.getElementById('resetAdminWidget')) return;
    if (opts.pin){ api.setPin(opts.pin); }

    var btn = document.createElement('button');
    btn.id = 'resetAdminWidget';
    btn.textContent = '⚙️';
    btn.title = 'Admin';
    btn.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:999999;border:1px solid #2a3853;background:#0f1422;color:#eaf1ff;border-radius:12px;padding:10px 12px;font-size:20px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.45)';
    document.body.appendChild(btn);

    var taps=0, last=0, timer=null;
    function tripleTap(){
      var now=Date.now();
      if (now - last > 800){ taps = 0; }
      taps++; last = now;
      clearTimeout(timer);
      timer = setTimeout(async function(){
        if (taps >= 3){
          // Auth with PIN if any
          var cfg = loadCfg();
          if (cfg.pin && typeof prompt==='function'){
            var p = prompt('PIN (4+ shifra):'); if (String(p)!==String(cfg.pin)){ taps=0; return; }
          }
          // Action sheet (simple)
          var choice = (typeof prompt==='function')
            ? prompt('Zgjedh veprimin:\n1) Reset i plotë\n2) Vetëm lokal\n3) Vetëm cloud\n4) Vetëm re-issue\n(Shkruaj 1,2,3,4)')
            : '1';
          try{
            if (choice==='2'){ var r=api.clearLocal(); alert('Lokal OK: ' + JSON.stringify(r)); }
            else if (choice==='3'){ var r=await api.clearCloud(); alert('Cloud OK: ' + JSON.stringify(r)); }
            else if (choice==='4'){ var r=await api.reissue(); alert(r?'Re-issue OK':'Re-issue JO'); }
            else { var r=await api.reset({}); alert('Reset '+(r&&r.ok?'OK':'JO')); }
          }catch(e){ alert('Gabim: '+(e&&e.message||e)); }
        }
        taps = 0;
      }, 300);
    }

    ['click','touchend'].forEach(function(evt){
      try{ btn.addEventListener(evt, tripleTap, {passive:true}); }catch(_){ btn.addEventListener(evt, tripleTap, false); }
    });
  };

  // ===== Optional KODI long-press hookup (off by default) =====
  // Enable by calling: resetAdmin.bindLongPress('#ticketCode')
  api.bindLongPress = function(sel){
    var el = (typeof sel==='string') ? document.querySelector(sel) : sel;
    if (!el || el.__resetLP) return; el.__resetLP = true;
    var t=null, start=function(){ t=setTimeout(function(){ api.reset({confirm:true}); },700); }, stop=function(){ if(t){clearTimeout(t); t=null;} };
    try{ el.addEventListener('touchstart', start, {passive:true}); }catch(_){ el.addEventListener('touchstart', start, false); }
    ['touchend','touchmove','touchcancel'].forEach(function(ev){ try{ el.addEventListener(ev, stop, {passive:true}); }catch(_){ el.addEventListener(ev, stop, false); } });
    el.addEventListener('mousedown', start, false);
    el.addEventListener('mouseup',   stop,  false);
    el.addEventListener('mouseleave',stop,  false);
  };

})();