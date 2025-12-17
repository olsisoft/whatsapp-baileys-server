import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { forwardToWebhook, processQueue } from './webhook.js';

let sock = null;
let connectionStatus = 'disconnected';
let reconnectAttempts = 0;
let myPhoneNumber = null;
const MAX_RECONNECT_ATTEMPTS = 5;

const logger = pino({ level: 'silent' });

export function getConnectionStatus() {
  return connectionStatus;
}

export function getMyPhoneNumber() {
  return myPhoneNumber;
}

export async function initWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const { version } = await fetchLatestBaileysVersion();

    console.log(`📱 Baileys version: ${version.join('.')}`);

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false,
      logger,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n📱 Scannez ce QR code avec WhatsApp Business:\n');
        qrcode.generate(qr, { small: true });
        global.currentQR = qr;
        connectionStatus = 'awaiting_qr';
        reconnectAttempts = 0;
      }

      if (connection === 'close') {
        global.currentQR = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.message || 'Unknown';
        
        console.log(`⚠️ Déconnexion - Code: ${statusCode}, Raison: ${reason}`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('❌ Session expirée. Supprimez le dossier auth/ et relancez.');
          connectionStatus = 'logged_out';
          return;
        }

        if (statusCode === DisconnectReason.badSession) {
          console.log('❌ Session corrompue. Suppression...');
          const fs = await import('fs');
          fs.rmSync('./auth', { recursive: true, force: true });
          reconnectAttempts = 0;
        }

        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          const delay = Math.min(reconnectAttempts * 3000, 15000);
          console.log(`🔄 Reconnexion ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} dans ${delay/1000}s...`);
          connectionStatus = 'reconnecting';
          setTimeout(initWhatsApp, delay);
        } else {
          console.log('❌ Trop de tentatives. Supprimez auth/ et relancez.');
          connectionStatus = 'failed';
        }
      }

      if (connection === 'open') {
        global.currentQR = null;
        connectionStatus = 'connected';
        reconnectAttempts = 0;
        
        // Récupérer notre propre numéro WhatsApp
        const rawId = sock.user?.id || '';
        myPhoneNumber = rawId.split(':')[0].split('@')[0];
        
        console.log('═══════════════════════════════════════════');
        console.log(`✅ WhatsApp connecté avec succès!`);
        console.log(`📞 Numéro connecté: ${myPhoneNumber}`);
        console.log('═══════════════════════════════════════════');
        
        // Traiter les messages en attente après reconnexion
        setTimeout(processQueue, 2000);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        // Ignorer nos propres messages
        if (msg.key.fromMe) continue;

        const senderPhone = msg.key.remoteJid?.replace('@s.whatsapp.net', '').replace('@lid', '');
        
        const messageData = {
          from: senderPhone,
          messageId: msg.key.id,
          timestamp: msg.messageTimestamp,
          type: getMessageType(msg.message),
          content: extractMessageContent(msg.message),
          pushName: msg.pushName || 'Unknown'
        };

        console.log(`📩 Message de ${messageData.pushName} (${senderPhone}): ${messageData.content}`);
        
        // Utiliser notre numéro pour le lookup du salon
        await forwardToWebhook(messageData, myPhoneNumber, false);
      }
    });

    return sock;
  } catch (error) {
    console.error('❌ Erreur initialisation:', error.message);
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      setTimeout(initWhatsApp, 5000);
    }
  }
}

function getMessageType(message) {
  if (!message) return 'unknown';
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.imageMessage) return 'image';
  if (message.videoMessage) return 'video';
  if (message.audioMessage) return 'audio';
  if (message.documentMessage) return 'document';
  if (message.stickerMessage) return 'sticker';
  if (message.locationMessage) return 'location';
  if (message.contactMessage) return 'contact';
  return 'unknown';
}

function extractMessageContent(message) {
  if (!message) return '';
  return message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    '[Media]';
}

export async function sendMessage(phone, content) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp non connecté');
  }

  const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: content });
  console.log(`📤 Message envoyé à ${phone}`);
}
