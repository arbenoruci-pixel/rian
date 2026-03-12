// lib/offlineSync.js
// 🛑 DEPRECATED (SKEDAR FOSIL) - Zëvendësuar plotësisht nga syncEngine.js
// Ky skedar është zbrazur qëllimisht për të parandaluar "Race Conditions" dhe "Fantazmat".

import { runSync } from './syncEngine';

export async function autoSyncOrders() {
  console.log('[offlineSync] Thirrja u ridrejtua te motori i ri i unifikuar (syncEngine)...');
  // I kalojmë topin motorit të ri, atij që ka Auto-Blacklist dhe mbrojtje
  return await runSync();
}

// ❌ Kemi hequr event listener-at e vjetër ('online') sepse ato 
// menaxhohen nga attachAutoSync() brenda syncEngine.js.
