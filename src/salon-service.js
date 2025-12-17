import axios from 'axios';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Cache en mémoire pour éviter trop de requêtes
const salonCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getSalonByWhatsAppPhone(phone) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('❌ SUPABASE_URL ou SUPABASE_ANON_KEY non configuré');
    return null;
  }

  // Nettoyer le numéro (enlever @s.whatsapp.net, +, espaces)
  const cleanPhone = phone?.replace(/[@s.whatsapp.net+\s-]/g, '').replace(/:.*/g, '');
  
  if (!cleanPhone) {
    console.warn('⚠️ Numéro de téléphone invalide');
    return null;
  }

  // Vérifier le cache
  const cached = salonCache.get(cleanPhone);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`📦 Cache hit pour ${cleanPhone}: ${cached.data?.name || 'non trouvé'}`);
    return cached.data;
  }

  try {
    console.log(`🔍 Recherche salon pour numéro: ${cleanPhone}`);
    
    const response = await axios.get(
      `${SUPABASE_URL}/rest/v1/salons`,
      {
        params: {
          whatsapp_phone: `eq.${cleanPhone}`,
          select: 'id,name,whatsapp_phone'
        },
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        },
        timeout: 10000
      }
    );

    const salon = response.data[0] || null;
    
    // Mettre en cache (même si null pour éviter de re-requêter)
    salonCache.set(cleanPhone, { data: salon, timestamp: Date.now() });
    
    if (salon) {
      console.log(`🏪 Salon trouvé: ${salon.name} (${salon.id})`);
    } else {
      console.warn(`⚠️ Aucun salon configuré pour le numéro ${cleanPhone}`);
    }

    return salon;
  } catch (error) {
    console.error('❌ Erreur lookup salon:', error.message);
    if (error.response) {
      console.error('📋 Status:', error.response.status);
      console.error('📋 Data:', JSON.stringify(error.response.data));
    }
    return null;
  }
}

// Vider le cache manuellement si besoin
export function clearSalonCache() {
  salonCache.clear();
  console.log('🗑️ Cache salons vidé');
}

// Afficher le contenu du cache (debug)
export function debugCache() {
  console.log('📦 Contenu du cache:');
  for (const [phone, data] of salonCache.entries()) {
    const age = Math.round((Date.now() - data.timestamp) / 1000);
    console.log(`  - ${phone}: ${data.data?.name || 'null'} (âge: ${age}s)`);
  }
}
