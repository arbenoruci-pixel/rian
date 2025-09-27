
/*! ux_fastlane.js v1.0 — tap responsiveness, single‑submit locks, faster flows */
(function(){
  if (window.__UX_FASTLANE__) return; window.__UX_FASTLANE__ = true;

  // ---- Unified "tap" helper (no double events on iOS/Android/Desktop) ----
  function onTap(el, handler){
    if (!el) return;
    var active=false, tid=null;
    function fire(e){
      if (active) return; active = true;
      try { handler(e); } finally { setTimeout(function(){ active=false; }, 350); } // lock briefly
    }
    // Prefer pointer events when available
    if (window.PointerEvent){
      el.addEventListener('pointerup', function(e){
        if (e.pointerType==='mouse' && e.button!==0) return;
        fire(e);
      }, false);
    } else {
      el.addEventListener('click', fire, false);
      el.addEventListener('touchend', function(e){ fire(e); }, {passive:true});
    }
  }

  // ---- One‑shot navigation / submit lock (prevents 20 taps syndrome) ----
  function oneShot(el, fn){
    if (!el) return;
    var busy=false;
    onTap(el, async function(e){
      if (busy) return;
      busy = true;
      try{
        if (e && typeof e.preventDefault==='function') e.preventDefault();
        el.setAttribute('aria-busy','true');
        el.disabled = true;
        await fn(e);
      }catch(err){
        console.warn('[fastlane] action failed', err && (err.message||err));
        // allow retry after brief delay
        setTimeout(function(){ busy=false; el.removeAttribute('aria-busy'); el.disabled=false; }, 600);
        return;
      }
      // keep disabled for a short time to guarantee single navigate
      setTimeout(function(){ busy=false; el.removeAttribute('aria-busy'); el.disabled=false; }, 1000);
    });
  }

  // ---- Helpers from your page if present ----
  function q(s){ return document.querySelector(s); }
  function r2(x){ return Math.round((x+Number.EPSILON)*100)/100; }

  // ---- Speed up PRANIMI -> PASTRIMI flow ----
  function wirePranimi(){
    var btnCont = q('#btnContinue');
    var btnSave = q('#btnSaveDraft');
    var rate = q('#rate');
    // Fallback hidden inputs if missing (won't change UI)
    if(!rate){
      rate = document.createElement('input'); rate.id='rate'; rate.type='hidden'; rate.value='1'; document.body.appendChild(rate);
    }

    async function saveDraft(status){
      // reuse your page's own saveDraftLocal/saveDraftOnline if present
      if (typeof saveDraftLocal==='function' && typeof saveDraftOnline==='function'){
        var data = saveDraftLocal(status); if (!data) throw new Error('saveLocal failed');
        await saveDraftOnline(data);
        return data;
      }
      // fallback minimal saver -> local only
      var OID = (window.OID || ('ord_'+Date.now()));
      var data = { id:OID, ts:Date.now(), status:status || 'pranim' };
      try{ localStorage.setItem('order_'+OID, JSON.stringify(data)); }catch(_){}
      return data;
    }

    oneShot(btnSave, async function(){ await saveDraft('pranim'); try{ alert('U ruajt.'); }catch(_){} });
    oneShot(btnCont, async function(){
      var d = await saveDraft('pastrim');
      var id = (d && d.id) || (window.OID);
      var url = '../pastrimi/?id=' + encodeURIComponent(id||'');
      // small delay so storage settles on slow phones
      setTimeout(function(){ location.href = url; }, 30);
    });
  }

  // ---- Reduce random hangs by avoiding heavy sync on tap ----
  // If your code syncs to Supabase on the same click, keep it but let navigation happen
  // after a tiny delay (above). This avoids UI "dead taps" while network blocks main thread.

  // ---- Init when DOM is ready ----
  if (document.readyState==='complete' || document.readyState==='interactive'){
    setTimeout(wirePranimi, 0);
  } else {
    document.addEventListener('DOMContentLoaded', wirePranimi, false);
  }
})();
