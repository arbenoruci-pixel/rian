// assets/doctor_off.js — block old doctor routes
(function(){ const p=(location.pathname||'').toLowerCase(); if(p.includes('doctor')){ location.replace('/'); }})();