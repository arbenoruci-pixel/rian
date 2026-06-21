// lib/net.js
export function isOnline(){
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

export function onOnline(cb){
  if(typeof window === "undefined") return;
  window.addEventListener("online", cb);
}
