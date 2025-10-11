/* flow-guard.js — minimal shim to prevent white screen if guard is missing */
(function(){
  if (window.FlowGuard) return;
  window.FlowGuard = {
    init: function(){
      try { console.log('%cFLOW GUARD (shim) active','font-weight:bold'); } catch(e){}
      // No-op: real guard can be added later
    },
    check: function(){ return true; } // always allow
  };
  try { window.FlowGuard.init(); } catch(_){}
})();