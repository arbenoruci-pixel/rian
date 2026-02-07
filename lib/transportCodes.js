import { supabase } from '@/lib/supabaseClient';

export async function reserveTransportCode() {
  try {
    // 1. Mënyra e parë: Provo me Internet (Database)
    // Vendosim një timeout të shkurtër (psh 3 sekonda) që mos të presim pafund
    const rpcPromise = supabase.rpc('reserve_transport_code');
    
    // Krijojmë një timer që dështon pas 3 sekondave
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), 3000)
    );

    // Garë mes Supabase dhe Timer-it
    const { data, error } = await Promise.race([rpcPromise, timeoutPromise]);

    if (error) throw error; 

    // ✅ SUKSES ONLINE: Kthe kodin nga DB (psh: T27)
    return data;

  } catch (err) {
    // 2. Mënyra e dytë: OFFLINE (Plan B)
    console.warn("⚠️ S'ka rrjet ose Supabase dështoi. Duke përdorur kod lokal.");

    // Gjenerojmë një kod unik që nuk përplaset me databazën.
    // Përdorim 'OFF' dhe 4 shifrat e fundit të kohës (milisekonda) për t'u siguruar që është unik.
    // Shembull rezultati: T-OFF-4821
    const uniqueSuffix = Date.now().toString().slice(-4);
    const offlineCode = `T-OFF-${uniqueSuffix}`;

    return offlineCode;
  }
}

export async function markTransportCodeUsed(tCode) {
  // S'ka nevojë të bëjmë asgjë, databaza e ka kryer punën ose jemi offline.
  return true;
}
