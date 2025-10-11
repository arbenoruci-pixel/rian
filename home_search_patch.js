
/*! home_search_patch.js — fast search by name, phone, or code using your existing storage */
(function(){
  if (window.__HOME_SEARCH_PATCH__) return; window.__HOME_SEARCH_PATCH__ = true;

  var LIST_KEY='order_list_v1';
  function q(s){ return document.querySelector(s); }
  function qq(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); }

  function norm(s){
    return (s||'').toString().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // strip accents
      .replace(/\s+/g,' ').trim();
  }
  function digits(s){ return (s||'').replace(/[^\d]/g,''); }

  function ensureUI(){
    var host = q('#clientList'); if (!host) return null;
    var sr = document.createElement('div'); sr.className='searchRow';
    sr.innerHTML = '<input id="searchBox" placeholder="Kërko: emër, telefon ose kod…"><button id="clearBtn">×</button>';
    host.parentNode.insertBefore(sr, host);
    var linkCSS = document.createElement('link'); linkCSS.rel='stylesheet'; linkCSS.href='./clients_list_styles.css';
    document.head.appendChild(linkCSS);
    return { host:host, input:sr.querySelector('#searchBox'), clear:sr.querySelector('#clearBtn') };
  }

  function loadIndex(){
    try{ return JSON.parse(localStorage.getItem(LIST_KEY)||'[]')||[]; }catch(_){ return []; }
  }

  function render(list, host){
    host.innerHTML='';
    list.forEach(function(it){
      var div=document.createElement('div'); div.className='cliItem';
      var code = (it && it.id) ? (('-'+String(it.id).replace(/^\D+/,'').slice(-4)) || '') : '';
      div.innerHTML = '<div class="cliMain">\
        <div class="cliName">'+(it.name||'Pa emër')+'</div>\
        <div class="cliSub"><span>'+ (it.phone||'') +'</span> <span class="cliCode">'+ (it.code||code||'') +'</span></div>\
      </div>\
      <button class="cliGo">HAP</button>';
      div.querySelector('.cliGo').addEventListener('click', function(){
        location.href = './pranimi/?id=' + encodeURIComponent(it.id);
      });
      host.appendChild(div);
    });
  }

  function filter(list, term){
    if (!term) return list;
    var t = norm(term), d = digits(term);
    return list.filter(function(it){
      var nm = norm(it.name||'');
      var ph = digits(it.phone||'');
      var cd = String(it.code||'').toLowerCase();
      return (nm.indexOf(t)>=0) || (d && ph.indexOf(d)>=0) || (cd.indexOf(t)>=0);
    });
  }

  function init(){
    var ui = ensureUI(); if(!ui) return;
    var idx = loadIndex();
    render(idx, ui.host);

    ui.input.addEventListener('input', function(){
      var f = filter(idx, ui.input.value);
      render(f, ui.host);
    }, {passive:true});
    ui.clear.addEventListener('click', function(){ ui.input.value=''; render(idx, ui.host); }, false);
  }

  if (document.readyState==='complete' || document.readyState==='interactive'){
    setTimeout(init, 0);
  } else {
    document.addEventListener('DOMContentLoaded', init, false);
  }
})();