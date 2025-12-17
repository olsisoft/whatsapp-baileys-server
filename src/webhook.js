import axios from 'axios';

const WEBHOOK_URL = process.env.WEBHOOK_URL;

export async function forwardToWebhook(messageData, salonId) {
  if (!WEBHOOK_URL) {
    console.warn('⚠️ WEBHOOK_URL non configuré');
    return false;
  }

  const payload = {
    salonId,
    event: 'message.received',
    data: messageData
  };

  try {
    const response = await axios.post(WEBHOOK_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    console.log(`✅ Webhook envoyé (${response.status})`);
    return true;
  } catch (error) {
    console.error('❌ Erreur webhook:', error.message);
    return false;
  }
}
