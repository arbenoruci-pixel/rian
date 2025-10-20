// /assets/pranimi.snapshot.js — read UI into a structured list
(function(){
  function $(s,r){return (r||document).querySelector(s);}
  function $all(s,r){return Array.from((r||document).querySelectorAll(s));}
  function num(v){var n=Number(String(v||'').replace(',','.'));return isFinite(n)?n:0;}

  function readRow(row){
    var inp=row.querySelector('input[type="number"]');
    var m2=num(inp?inp.value:0);
    var img=row.querySelector('.thumb'); var photo=img&&img.src?img.src:null;
    var kind=row.closest('[data-kind]')?.getAttribute('data-kind')||'tepiha';
    return {kind,m2,photo};
  }

  window.setPiecePhoto=function(row,url){
    var img=row.querySelector('.thumb');
    if(!img){ img=document.createElement('img'); img.className='thumb'; img.style.width='44px'; img.style.height='44px'; img.style.objectFit='cover'; img.style.borderRadius='10px'; row.insertBefore(img,row.firstChild); }
    img.src=url; img.style.display='inline-block';
    row.setAttribute('data-photo',url);
  };

  window.getPiecesSnapshot=function(){
    var out=[];
    $all('#list-tepiha .piece-row').forEach(r=>{var x=readRow(r); if(x.m2>0||x.photo) out.push(x);});
    $all('#list-staza .piece-row').forEach(r=>{var x=readRow(r); x.kind='staza'; if(x.m2>0||x.photo) out.push(x);});
    var stairs=document.getElementById('stairsM2'); if(stairs){var m=num(stairs.textContent||'0'); if(m>0) out.push({kind:'shkallore',m2:m,photo:null});}
    return out;
  };
})();