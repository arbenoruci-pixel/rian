
/*! flow_lockdown.js — guarantees one‑tap navigation & no "disappear" without move */
(function(){
  if (window.__FLOW_LOCKDOWN__) return; window.__FLOW_LOCKDOWN__ = true;

  function q(s){ return document.querySelector(s); }
  function qq(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function ready(fn){ if (document.readyState==='complete'||document.readyState==='interactive') setTimeout(fn,0); else document.addEventListener('DOMContentLoaded', fn, false); }
  function onceTap(el, fn){
    if (!el) return;
    el.style.touchAction = 'manipulation';
    el.style.webkitTapHighlightColor = 'rgba(255,255,255,0.1)';
    var lock=false;
    function run(e){
      if (lock) return;
      lock = true;
      try{
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        fn();
      } finally {
        setTimeout(function(){ lock=false; }, 500);
      }
    }
    if (window.PointerEvent){
      el.addEventListener('pointerup', function(e){
        if (e.pointerType==='mouse' && e.button!==0) return;
        run(e);
      }, true);
    }
    el.addEventListener('click', function(e){ run(e); }, true);
    el.addEventListener('touchend', function(_e){}, {passive:true});
  }

  function go(url){
    try{ location.href = url; }catch(_){ try{ window.location.assign(url); }catch(_2){} }
  }

  function withOID(url){
    try{
      var oid = window.OID || (function(){
        try{
          var data = JSON.parse(localStorage.getItem('order_'+(window.OID||''))||'null');
          return (data && data.id) ? data.id : '';
        }catch(_){ return ''; }
      })();
      if (!oid) return url;
      if (url.indexOf('?')===-1) return url + '?id='+encodeURIComponent(oid);
      if (!/[?&]id=/.test(url)) return url + '&id='+encodeURIComponent(oid);
      return url;
    }catch(_){ return url; }
  }

  // Fallback completion after status change
  async function markAndMaybeNav(fn, nextUrl){
    try{ if (typeof fn === 'function'){ await fn(); } }catch(_){}
    if (nextUrl) go(nextUrl);
  }

  ready(function(){
    // PRANIMI: VAZHDO must always move to pastrimi
    var btnGo = q('#btnContinue');
    if (btnGo){
      onceTap(btnGo, function(){
        var m2 = parseFloat((q('#m2Total') && q('#m2Total').textContent) || '0')||0;
        if (!m2 || m2<=0){ alert('Shto të paktën 1 m² para se të vazhdosh.'); return; }
        try{ if (window.saveDraftLocal){ window.__LAST_OID__ = (window.saveDraftLocal('pastrim')||{}).id || window.OID; } }catch(_){}
        try{ if (window.saveDraftOnline && window.baseData){ window.saveDraftOnline(window.baseData('pastrim')); } }catch(_){}
        var href = btnGo.getAttribute('href') || '../pastrimi/';
        go(withOID(href));
      });
    }

    // Footer buttons: force navigate
    qq('.footwrap a.btn, .footwrap button.btn').forEach(function(b){
      onceTap(b, function(){
        var href = b.getAttribute('href'); if (href) go(href);
      });
    });

    // PASTRIMI: GATI should move right away
    qq('[data-action="gati"], .btn-gati').forEach(function(b){
      onceTap(b, function(){
        var id = b.getAttribute('data-id') || '';
        var next = (location.pathname.indexOf('/pastrimi/')>-1) ? '../gati/' : location.pathname;
        if (typeof window.markOrderReady === 'function'){
          markAndMaybeNav(function(){ return window.markOrderReady(id); }, next);
        }else{
          go(next);
        }
      });
    });

    // GATI: MARRJE SOT should be instant
    qq('[data-action="marrje"], .btn-marrje').forEach(function(b){
      onceTap(b, function(){
        var id = b.getAttribute('data-id') || '';
        var next = (location.pathname.indexOf('/gati/')>-1) ? '../marrje-sot/' : location.pathname;
        if (typeof window.markOrderTaken === 'function'){
          markAndMaybeNav(function(){ return window.markOrderTaken(id); }, next);
        }else{
          go(next);
        }
      });
    });

    // PAS TRIMI: SMS must not change status / navigate
    qq('.btn-sms,[data-action="sms"]').forEach(function(b){
      onceTap(b, function(){
        try{ if (typeof window.openSMS==='function'){ window.openSMS(); return; } }catch(_){}
      });
    });
  });
})();
