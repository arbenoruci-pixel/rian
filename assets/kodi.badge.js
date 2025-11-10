// Shows/locks the KODI badge and exposes window.ensureCode()
// Requires /assets/supabase.js to have run first (it puts helpers on window).

(function () {
  function $(s, r){ return (r||document).querySelector(s); }
  function digits(v){ return String(v==null?'':v).replace(/\D/g,''); }
  function qs(name){
    var m = (location.search||'').match(new RegExp('[?&]'+name+'=([^&]+)'));
    return m ? decodeURIComponent(m[1].replace(/\+/g,' ')) : null;
  }

  var BADGE = null;
  function setBadge(val){
    if (!BADGE) BADGE = $('#ticketCode') || $('.badge.kodi') || $('[data-code]');
    if (!BADGE) return;
    BADGE.setAttribute('data-code', val ? String(val) : '');
    BADGE.textContent = 'KODI: ' + (val ? String(val) : '—');
  }

  // public: returns the assigned code (string), ensuring it exists
  window.ensureCode = async function ensureCode(){
    // 1) if page was opened with ?code=xxx we lock to that value
    var fromQS = digits(qs('code'));
    if (fromQS) {
      window.assignedCode = fromQS;
      setBadge(fromQS);
      return fromQS;
    }

    // 2) use cached value if already assigned
    if (window.assignedCode) {
      setBadge(window.assignedCode);
      return window.assignedCode;
    }

    // 3) ask DB for the latest code and +1
    try{
      if (!window.select) throw new Error('no select()');
      var rows = await window.select('orders', { select:'code', order:'created_at.desc', limit:'1' });
      var last = rows && rows[0] ? digits(rows[0].code) : '';
      var nextNum = (last ? (parseInt(last,10)||0) : 0) + 1;
      window.assignedCode = String(nextNum);
      setBadge(window.assignedCode);
      return window.assignedCode;
    }catch(e){
      // 4) fallback: local bump so user is not blocked
      try{
        var n = parseInt(localStorage.getItem('local_code')||'0',10) || 0;
        n = n + 1;
        localStorage.setItem('local_code', String(n));
        window.assignedCode = String(n);
        setBadge(window.assignedCode);
        return window.assignedCode;
      }catch(_){
        setBadge('');
        return '';
      }
    }
  };

  // boot: show something immediately (will be corrected once DB responds)
  document.addEventListener('DOMContentLoaded', function(){
    setBadge('—');
    // fire and forget; don’t block UI
    window.ensureCode();
  });
})();