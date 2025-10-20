// /assets/pranimi.clientcam.patch.js
(function(){
  function $(s,r){ return (r||document).querySelector(s); }
  function ensureThumb(btn){
    if(!btn) return null;
    var img = btn.querySelector('img.thumb');
    if(!img){
      img=document.createElement('img');
      img.className='thumb'; img.alt='';
      img.style.position='absolute'; img.style.inset='0';
      img.style.width='100%'; img.style.height='100%';
      img.style.objectFit='cover'; img.style.borderRadius='10px';
      img.style.display='none'; img.style.zIndex='2';
      if(getComputedStyle(btn).position==='static'){ btn.style.position='relative'; }
      btn.appendChild(img);
    }
    return img;
  }
  function preview(src){
    if(!src) return;
    var ov=document.createElement('div');
    ov.style='position:fixed;inset:0;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;z-index:99999';
    var img=new Image(); img.src=src; img.style.maxWidth='100%'; img.style.maxHeight='100%';
    ov.appendChild(img); ov.onclick=function(){ ov.remove(); };
    document.body.appendChild(ov);
  }
  function choose(cb){
    var input=document.createElement('input');
    input.type='file'; input.accept='image/*;capture=camera'; input.setAttribute('capture','environment');
    input.style.display='none'; document.body.appendChild(input);
    input.onchange=function(){
      var f=input.files&&input.files[0]; if(!f){ input.remove(); return; }
      var rd=new FileReader(); rd.onload=function(){ cb(String(rd.result||'')); input.remove(); };
      rd.readAsDataURL(f);
    };
    input.click();
  }
  function longPressSheet(onRetake, onRemove){
    var sh=document.createElement('div');
    sh.style='position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;z-index:99999';
    sh.innerHTML =
      '<div style="background:#0c0f16;border:1px solid #273143;border-radius:14px 14px 0 0;width:100%;max-width:520px;padding:12px">'+
        '<button id="ret" style="width:100%;min-height:48px;border:0;border-radius:12px;background:#1e60ff;color:#fff;font-weight:1000">📷 Zëvendëso</button>'+
        '<button id="rem" style="width:100%;min-height:46px;border:1px solid #2c3a55;border-radius:12px;background:#0b111d;color:#e6f0ff;font-weight:1000;margin-top:10px">🗑️ Hiq</button>'+
        '<button id="cl"  style="width:100%;min-height:42px;border:0;border-radius:12px;background:#0c0f16;color:#9fb3d7;font-weight:900;margin-top:6px">Mbyll</button>'+
      '</div>';
    document.body.appendChild(sh);
    function close(){ sh.remove(); }
    $('#ret',sh).onclick=function(){ onRetake(); close(); };
    $('#rem',sh).onclick=function(){ onRemove(); close(); };
    $('#cl', sh).onclick=close;
    sh.addEventListener('click', function(e){ if(e.target===sh) close(); });
  }

  function wireCam(btn, storageKey){
    if(!btn) return;
    var thumb=ensureThumb(btn);

    if(storageKey){
      try{ var saved=sessionStorage.getItem(storageKey); if(saved){ thumb.src=saved; thumb.style.display='block'; } }catch(_){}
    }

    var tmr=null, long=false;
    function down(){ long=false; tmr=setTimeout(function(){ long=true; openSheet(); },600); }
    function up(){
      clearTimeout(tmr);
      if(long) return;
      // tap
      if(thumb.style.display!=='none' && thumb.src){ preview(thumb.src); }
      else { choose(function(data){ thumb.src=data; thumb.style.display='block'; if(storageKey){ try{ sessionStorage.setItem(storageKey, data); }catch(_){ } } }); }
    }
    function openSheet(){
      longPressSheet(function(){ // replace
        choose(function(data){ thumb.src=data; thumb.style.display='block'; if(storageKey){ try{ sessionStorage.setItem(storageKey, data); }catch(_){ } } });
      }, function(){ // remove
        thumb.src=''; thumb.style.display='none'; if(storageKey){ try{ sessionStorage.removeItem(storageKey); }catch(_){ } }
      });
    }

    btn.addEventListener('touchstart', down, {passive:true});
    btn.addEventListener('mousedown', down);
    btn.addEventListener('touchend', up);
    btn.addEventListener('mouseup', up);
    btn.addEventListener('mouseleave', function(){ clearTimeout(tmr); });
  }

  function findClientBtn(){
    return document.getElementById('clientCamBtn')
        || document.querySelector('#name ~ .cam-btn')
        || document.querySelector('.client .cam-btn')
        || document.querySelector('label.cam-btn')
        || document.querySelector('[data-role="client-cam"]');
  }

  document.addEventListener('DOMContentLoaded', function(){
    // client photo
    wireCam(findClientBtn(), 'client_photo_thumb');

    // stairs photo
    wireCam(document.getElementById('stairsCamBtn'), 'stairs_photo_thumb');

    // row cameras (any existing, and future rows via capture)
    document.body.addEventListener('click', function(e){
      var b = e.target.closest && e.target.closest('.piece-row .cam-btn');
      if(b && !b.__wired__){ wireCam(b, null); b.__wired__=true; }
    });
    $all('.piece-row .cam-btn').forEach(function(b){ if(!b.__wired__){ wireCam(b,null); b.__wired__=true; } });
  });
})();
