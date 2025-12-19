import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import OpenAI from 'openai';
import { 
  enqueue, 
  dequeue, 
  incrementAttempts, 
  getQueuedMessages, 
  cleanupFailedMessages, 
  getQueueLength 
} from './queue.js';

const logger = pino({ level: 'silent' });
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL) || 5000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Client OpenAI pour transcription
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const sessions = new Map();
const statusCallbacks = new Map();
const pollingIntervals = new Map();
const reconnectTimers = new Map();

// Exponential backoff with jitter
function calculateBackoffDelay(attempt) {
  const baseDelay = 1000; // 1 second
  const maxDelay = 60000; // 60 seconds max
  const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  // Add jitter: random value between 0 and 30% of the delay
  const jitter = Math.random() * exponentialDelay * 0.3;
  return Math.floor(exponentialDelay + jitter);
}

// Add jitter to polling interval to prevent thundering herd
function getPollingIntervalWithJitter() {
  const jitter = Math.random() * POLLING_INTERVAL * 0.2; // 20% jitter
  return POLLING_INTERVAL + jitter;
}

// Créer le dossier temp s'il n'existe pas
const TEMP_DIR = './temp';
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

export function getSession(salonId) {
  return sessions.get(salonId);
}

export function getAllSessions() {
  const result = [];
  for (const [salonId, session] of sessions.entries()) {
    result.push({
      salonId,
      status: session.status,
      phoneNumber: session.phoneNumber,
      connectedAt: session.connectedAt
    });
  }
  return result;
}

export function onStatusChange(salonId, callback) {
  if (!statusCallbacks.has(salonId)) {
    statusCallbacks.set(salonId, []);
  }
  statusCallbacks.get(salonId).push(callback);

  return () => {
    const callbacks = statusCallbacks.get(salonId);
    const index = callbacks.indexOf(callback);
    if (index > -1) callbacks.splice(index, 1);
  };
}

function notifyStatusChange(salonId, data) {
  const callbacks = statusCallbacks.get(salonId) || [];
  for (const callback of callbacks) {
    try {
      callback(data);
    } catch (e) {
      console.error('Erreur callback:', e);
    }
  }
}

// ═══════════════════════════════════════════
// TRANSCRIPTION VOCALE AVEC OPENAI WHISPER
// ═══════════════════════════════════════════

async function transcribeAudio(audioBuffer, messageId) {
  if (!openai) {
    console.warn('⚠️ OPENAI_API_KEY non configuré - transcription désactivée');
    return null;
  }

  const tempPath = path.join(TEMP_DIR, `voice-${messageId}.ogg`);

  try {
    // Sauvegarder le fichier temporairement
    fs.writeFileSync(tempPath, audioBuffer);

    console.log(`🎤 Transcription en cours...`);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-1',
      language: 'fr'  // Français par défaut, peut être changé
    });

    console.log(`✅ Transcription réussie: "${transcription.text.substring(0, 50)}..."`);

    return transcription.text;

  } catch (error) {
    console.error('❌ Erreur transcription:', error.message);
    return null;
  } finally {
    // Nettoyer le fichier temporaire
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (e) {
      console.error('Erreur suppression fichier temp:', e);
    }
  }
}

// ═══════════════════════════════════════════
// EXTRACTION NUMÉRO / LID DEPUIS JID
// ═══════════════════════════════════════════

function extractPhoneFromJid(jid) {
  if (!jid) {
    return { phone: null, isLid: false, lidId: null };
  }
  
  if (jid.includes('@lid')) {
    const lidNumber = jid.replace('@lid', '');
    console.log(`📋 LID détecté: ${lidNumber}`);
    return { phone: null, isLid: true, lidId: lidNumber };
  }
  
  const match = jid.match(/^(\d+)@s\.whatsapp\.net$/);
  if (match) {
    const digits = match[1];
    
    if (digits.length >= 8 && digits.length <= 15) {
      return { phone: `+${digits}`, isLid: false, lidId: null };
    } else {
      console.log(`📋 Numéro long traité comme LID: ${digits}`);
      return { phone: null, isLid: true, lidId: digits };
    }
  }
  
  console.log(`⚠️ Format JID inconnu: ${jid}`);
  return { phone: null, isLid: false, lidId: null };
}

// ═══════════════════════════════════════════
// CONSTRUIRE LE JID POUR L'ENVOI
// ═══════════════════════════════════════════

function buildJid(message) {
  if (message.isLid && message.lidId) {
    return `${message.lidId}@lid`;
  }
  
  if (message.phoneNumber) {
    const cleanPhone = message.phoneNumber.replace(/[+\s-]/g, '');
    return `${cleanPhone}@s.whatsapp.net`;
  }
  
  return null;
}

// ═══════════════════════════════════════════
// POLLING - MESSAGES SORTANTS
// ═══════════════════════════════════════════

async function startPolling(salonId) {
  stopPolling(salonId);

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn(`⚠️ [${salonId}] Polling désactivé - SUPABASE_URL ou SUPABASE_ANON_KEY manquant`);
    return;
  }

  console.log(`🔄 [${salonId}] Démarrage du polling (interval: ~${POLLING_INTERVAL}ms avec jitter)`);

  // Use dynamic interval with jitter to prevent thundering herd
  let isPolling = false;
  const poll = async () => {
    // Skip if already polling (prevents overlapping polls)
    if (isPolling) return;

    isPolling = true;
    try {
      await pollPendingMessages(salonId);
    } finally {
      isPolling = false;
    }
  };

  const intervalId = setInterval(poll, getPollingIntervalWithJitter());
  pollingIntervals.set(salonId, intervalId);
}

function stopPolling(salonId) {
  const intervalId = pollingIntervals.get(salonId);
  if (intervalId) {
    clearInterval(intervalId);
    pollingIntervals.delete(salonId);
    console.log(`⏹️ [${salonId}] Polling arrêté`);
  }
}

async function pollPendingMessages(salonId) {
  const session = sessions.get(salonId);
  if (!session || session.status !== 'connected') {
    return;
  }

  try {
    const response = await axios.get(
      `${SUPABASE_URL}/functions/v1/whatsapp-pending-messages`,
      {
        params: { salonId },
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    const { success, messages, count } = response.data;

    if (!success || !messages || messages.length === 0) {
      return;
    }

    console.log(`📬 [${salonId}] ${count || messages.length} message(s) à envoyer`);

    for (const msg of messages) {
      try {
        const jid = buildJid(msg);
        
        if (!jid) {
          console.warn(`⚠️ [${salonId}] Impossible de construire JID pour message ${msg.id}`);
          await markMessageSent([msg.id], 'failed', null, 'JID invalide');
          continue;
        }

        const destination = msg.isLid ? `LID:${msg.lidId}` : msg.phoneNumber;
        console.log(`📤 [${salonId}] Envoi à ${destination}: "${msg.content.substring(0, 50)}..."`);

        const result = await session.socket.sendMessage(jid, { text: msg.content });

        console.log(`✅ [${salonId}] Message envoyé à ${destination}`);

        await markMessageSent([msg.id], 'sent', result?.key?.id);

      } catch (sendError) {
        const destination = msg.isLid ? `LID:${msg.lidId}` : msg.phoneNumber;
        console.error(`❌ [${salonId}] Erreur envoi à ${destination}:`, sendError.message);
        await markMessageSent([msg.id], 'failed', null, sendError.message);
      }
    }

  } catch (error) {
    if (!error.message.includes('timeout') && !error.message.includes('ECONNREFUSED')) {
      console.error(`❌ [${salonId}] Erreur polling:`, error.message);
    }
  }
}

async function markMessageSent(messageIds, status, whatsappMessageId = null, errorMessage = null) {
  try {
    const payload = { messageIds, status };
    
    if (whatsappMessageId) payload.whatsappMessageId = whatsappMessageId;
    if (errorMessage) payload.errorMessage = errorMessage;

    await axios.post(
      `${SUPABASE_URL}/functions/v1/whatsapp-mark-sent`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    console.log(`📝 Message(s) marqué(s) comme ${status}`);
  } catch (error) {
    console.error('❌ Erreur mark-sent:', error.message);
  }
}

// ═══════════════════════════════════════════
// WEBHOOK - MESSAGES ENTRANTS
// ═══════════════════════════════════════════

async function forwardToWebhook(salonId, messageData, fromQueue = false) {
  if (!WEBHOOK_URL) {
    console.warn('⚠️ WEBHOOK_URL non configuré');
    return false;
  }

  const payload = {
    type: 'message',
    salonId: salonId,
    phone: messageData.resolvedPhone,
    message: messageData.content,
    customerName: messageData.pushName || null,
    whatsappMessageId: messageData.messageId,
    isLid: messageData.isLid || false,
    lidId: messageData.lidId || null,
    // Nouveaux champs pour les messages vocaux
    isVoiceMessage: messageData.isVoiceMessage || false,
    voiceTranscription: messageData.voiceTranscription || null,
    voiceDurationSeconds: messageData.voiceDurationSeconds || null
  };

  console.log('═══════════════════════════════════════════');
  console.log(`📤 Envoi webhook ${fromQueue ? '(retry)' : ''}`);
  console.log(`   Salon: ${salonId}`);
  if (payload.isLid) {
    console.log(`   Type: LID`);
    console.log(`   LID ID: ${payload.lidId}`);
  } else {
    console.log(`   Phone: ${payload.phone}`);
  }
  if (payload.isVoiceMessage) {
    console.log(`   🎤 Message vocal (${payload.voiceDurationSeconds}s)`);
    console.log(`   📝 Transcription: ${payload.voiceTranscription || 'N/A'}`);
  }
  console.log(`   Message: ${payload.message}`);
  console.log(`   Customer: ${payload.customerName}`);
  console.log('═══════════════════════════════════════════');

  try {
    const response = await axios.post(WEBHOOK_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000  // Plus de temps pour les vocaux
    });

    console.log(`✅ Webhook OK - Status: ${response.status}`);
    
    if (fromQueue) {
      dequeue(messageData.messageId);
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Erreur webhook: ${error.message}`);
    
    if (error.response?.status === 400) {
      console.log('⚠️ Erreur 400 - message ignoré');
      if (fromQueue) dequeue(messageData.messageId);
      return false;
    }
    
    if (!fromQueue) {
      enqueue({ ...messageData, salonId });
    } else {
      incrementAttempts(messageData.messageId);
    }
    
    return false;
  }
}

export async function processQueue() {
  const queuedMessages = getQueuedMessages();
  
  if (queuedMessages.length === 0) return;
  
  console.log(`\n🔄 Traitement de ${queuedMessages.length} messages en attente...\n`);
  
  for (const msg of queuedMessages) {
    await forwardToWebhook(msg.salonId, msg, true);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  cleanupFailedMessages();
  
  const remaining = getQueueLength();
  if (remaining > 0) {
    console.log(`📦 ${remaining} messages encore en attente`);
  } else {
    console.log('✅ Queue vidée');
  }
}

// ═══════════════════════════════════════════
// GESTION DES SESSIONS
// ═══════════════════════════════════════════

export async function createSession(salonId) {
  const existing = sessions.get(salonId);
  if (existing && existing.status === 'connected') {
    console.log(`📱 Session ${salonId} déjà connectée`);
    return existing;
  }

  const authDir = path.join('./auth', salonId);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const session = {
    salonId,
    status: 'initializing',
    qrCode: null,
    qrCodeBase64: null,
    phoneNumber: null,
    socket: null,
    connectedAt: null,
    reconnectAttempts: 0
  };

  sessions.set(salonId, session);
  notifyStatusChange(salonId, { status: 'initializing' });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
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

    session.socket = sock;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.status = 'qr_ready';
        session.qrCode = qr;

        try {
          session.qrCodeBase64 = await QRCode.toDataURL(qr, {
            width: 300,
            margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' }
          });
        } catch (e) {
          console.error('Erreur génération QR:', e);
        }

        console.log(`📱 QR code prêt pour salon ${salonId}`);
        notifyStatusChange(salonId, {
          status: 'qr_ready',
          qrCode: session.qrCodeBase64
        });
      }

      if (connection === 'close') {
        session.qrCode = null;
        session.qrCodeBase64 = null;
        stopPolling(salonId);

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.message || 'Unknown';

        console.log(`⚠️ Déconnexion salon ${salonId} - Code: ${statusCode}, Raison: ${reason}`);

        if (statusCode === DisconnectReason.loggedOut) {
          session.status = 'logged_out';
          session.phoneNumber = null;
          fs.rmSync(authDir, { recursive: true, force: true });
          notifyStatusChange(salonId, { status: 'logged_out' });
          return;
        }

        if (statusCode === DisconnectReason.badSession) {
          fs.rmSync(authDir, { recursive: true, force: true });
          session.reconnectAttempts = 0;
        }

        const maxReconnectAttempts = 8; // More attempts with exponential backoff
        if (session.reconnectAttempts < maxReconnectAttempts) {
          session.reconnectAttempts++;
          session.status = 'reconnecting';

          const delay = calculateBackoffDelay(session.reconnectAttempts);

          notifyStatusChange(salonId, {
            status: 'reconnecting',
            attempt: session.reconnectAttempts,
            maxAttempts: maxReconnectAttempts,
            nextRetryIn: delay
          });

          console.log(`🔄 [${salonId}] Reconnecting in ${delay}ms (attempt ${session.reconnectAttempts}/${maxReconnectAttempts})`);

          // Clear existing reconnect timer
          const existingTimer = reconnectTimers.get(salonId);
          if (existingTimer) {
            clearTimeout(existingTimer);
          }

          const timerId = setTimeout(() => {
            reconnectTimers.delete(salonId);
            createSession(salonId).catch(err => {
              console.error(`❌ [${salonId}] Reconnect failed:`, err.message);
            });
          }, delay);

          reconnectTimers.set(salonId, timerId);
        } else {
          session.status = 'failed';
          notifyStatusChange(salonId, { status: 'failed', reason: 'Max reconnection attempts reached' });
          console.error(`❌ [${salonId}] Session failed after ${maxReconnectAttempts} attempts`);
        }
      }

      if (connection === 'open') {
        session.status = 'connected';
        session.qrCode = null;
        session.qrCodeBase64 = null;
        session.reconnectAttempts = 0;
        session.connectedAt = new Date().toISOString();

        const rawId = sock.user?.id || '';
        session.phoneNumber = rawId.split(':')[0].split('@')[0];

        console.log(`✅ Salon ${salonId} connecté! Numéro: ${session.phoneNumber}`);
        
        // Afficher le statut de la transcription
        if (openai) {
          console.log(`🎤 Transcription vocale: ACTIVÉE`);
        } else {
          console.log(`🎤 Transcription vocale: DÉSACTIVÉE (OPENAI_API_KEY manquant)`);
        }

        notifyStatusChange(salonId, {
          status: 'connected',
          phoneNumber: session.phoneNumber
        });

        startPolling(salonId);
        setTimeout(() => processQueue(), 2000);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // ═══════════════════════════════════════════
    // RÉCEPTION DES MESSAGES (AVEC TRANSCRIPTION VOCALE)
    // ═══════════════════════════════════════════
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid || '';
        const extracted = extractPhoneFromJid(remoteJid);

        // Initialiser les données du message
        let content = '';
        let messageType = 'unknown';
        let isVoiceMessage = false;
        let voiceTranscription = null;
        let voiceDurationSeconds = null;

        // ═══════════════════════════════════════════
        // TRAITEMENT MESSAGE VOCAL
        // ═══════════════════════════════════════════
        if (msg.message?.audioMessage?.ptt) {
          isVoiceMessage = true;
          voiceDurationSeconds = msg.message.audioMessage.seconds || 0;
          messageType = 'voice';

          console.log(`\n🎤 MESSAGE VOCAL REÇU (${voiceDurationSeconds}s)`);

          try {
            // Télécharger l'audio
            console.log(`   ⬇️ Téléchargement de l'audio...`);
            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              {
                logger,
                reuploadRequest: sock.updateMediaMessage
              }
            );

            console.log(`   ✅ Audio téléchargé (${buffer.length} bytes)`);

            // Transcrire avec Whisper
            if (openai) {
              voiceTranscription = await transcribeAudio(buffer, msg.key.id);
              
              if (voiceTranscription) {
                content = voiceTranscription;
                console.log(`   📝 Transcription: "${voiceTranscription}"`);
              } else {
                content = '[Message vocal - transcription échouée]';
              }
            } else {
              content = '[Message vocal - transcription non configurée]';
              console.log(`   ⚠️ Transcription désactivée`);
            }

          } catch (downloadError) {
            console.error(`   ❌ Erreur téléchargement audio:`, downloadError.message);
            content = '[Message vocal - erreur téléchargement]';
          }

        } else {
          // Message texte ou autre
          content = extractMessageContent(msg.message);
          messageType = getMessageType(msg.message);
        }

        const messageData = {
          from: remoteJid,
          resolvedPhone: extracted.phone,
          isLid: extracted.isLid,
          lidId: extracted.lidId,
          messageId: msg.key.id,
          timestamp: msg.messageTimestamp,
          type: messageType,
          content: content,
          pushName: msg.pushName || null,
          isVoiceMessage: isVoiceMessage,
          voiceTranscription: voiceTranscription,
          voiceDurationSeconds: voiceDurationSeconds
        };

        // Log du message
        console.log(`\n═══════════════════════════════════════════`);
        console.log(`📩 MESSAGE REÇU`);
        console.log(`   Salon: ${salonId}`);
        console.log(`   JID: ${remoteJid}`);
        
        if (extracted.isLid) {
          console.log(`   📋 Type: LID`);
          console.log(`   📋 LID ID: ${extracted.lidId}`);
        } else {
          console.log(`   📱 Phone: ${extracted.phone}`);
        }
        
        console.log(`   Nom: ${messageData.pushName || 'Inconnu'}`);
        console.log(`   Type: ${messageType}`);
        
        if (isVoiceMessage) {
          console.log(`   🎤 Durée: ${voiceDurationSeconds}s`);
          console.log(`   📝 Transcription: ${voiceTranscription || 'N/A'}`);
        }
        
        console.log(`   Contenu: ${content}`);
        console.log(`═══════════════════════════════════════════\n`);

        await forwardToWebhook(salonId, messageData, false);
      }
    });

    return session;
  } catch (error) {
    console.error(`❌ Erreur création session ${salonId}:`, error.message);
    session.status = 'error';
    notifyStatusChange(salonId, { status: 'error', error: error.message });
    return session;
  }
}

export async function disconnectSession(salonId) {
  const session = sessions.get(salonId);
  if (!session) return false;

  // Stop polling
  stopPolling(salonId);

  // Clear reconnect timer
  const reconnectTimer = reconnectTimers.get(salonId);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimers.delete(salonId);
  }

  // Remove event listeners if socket exists
  if (session.socket?.ev) {
    try {
      session.socket.ev.removeAllListeners();
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  try {
    if (session.socket) {
      await session.socket.logout();
    }
  } catch (e) {
    console.error('Erreur logout:', e.message);
  }

  const authDir = path.join('./auth', salonId);
  try {
    fs.rmSync(authDir, { recursive: true, force: true });
  } catch (e) {
    console.error('Erreur suppression auth:', e.message);
  }

  sessions.delete(salonId);
  statusCallbacks.delete(salonId); // Clean up callbacks too
  notifyStatusChange(salonId, { status: 'disconnected' });

  console.log(`🔌 Session ${salonId} déconnectée et nettoyée`);
  return true;
}

// Clean up dead sessions periodically
export function cleanupDeadSessions() {
  const deadSessionTimeout = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();

  for (const [salonId, session] of sessions.entries()) {
    // Clean up sessions stuck in 'failed' status
    if (session.status === 'failed') {
      console.log(`🧹 Cleaning up failed session: ${salonId}`);
      disconnectSession(salonId).catch(() => {});
      continue;
    }

    // Clean up sessions stuck in 'initializing' for too long
    if (session.status === 'initializing' && session.createdAt) {
      const age = now - new Date(session.createdAt).getTime();
      if (age > deadSessionTimeout) {
        console.log(`🧹 Cleaning up stuck session: ${salonId}`);
        disconnectSession(salonId).catch(() => {});
      }
    }
  }
}

export async function sendMessage(salonId, phone, content, isLid = false, lidId = null) {
  const session = sessions.get(salonId);
  if (!session || session.status !== 'connected') {
    throw new Error('Session non connectée');
  }

  const jid = buildJid({ phoneNumber: phone, isLid, lidId });
  
  if (!jid) {
    throw new Error('Impossible de construire le JID');
  }
  
  const result = await session.socket.sendMessage(jid, { text: content });
  const destination = isLid ? `LID:${lidId}` : phone;
  console.log(`📤 [${salonId}] Message envoyé à ${destination}`);

  return result;
}

// ═══════════════════════════════════════════
// ENVOI DE MÉDIAS (Images, Vidéos, Documents)
// ═══════════════════════════════════════════
export async function sendMediaMessage(salonId, phone, media, options = {}) {
  const session = sessions.get(salonId);
  if (!session || session.status !== 'connected') {
    throw new Error('Session non connectée');
  }

  const { isLid, lidId } = options;
  const jid = buildJid({ phoneNumber: phone, isLid, lidId });

  if (!jid) {
    throw new Error('Impossible de construire le JID');
  }

  // Valider le type de média
  const validTypes = ['image', 'video', 'audio', 'document', 'sticker'];
  if (!validTypes.includes(media.type)) {
    throw new Error(`Type de média invalide: ${media.type}. Types supportés: ${validTypes.join(', ')}`);
  }

  // Construire le message selon le type
  let messageContent = {};

  try {
    // Récupérer le média (URL ou buffer)
    let mediaData;
    if (media.url) {
      // Télécharger depuis URL
      console.log(`📥 [${salonId}] Téléchargement média depuis: ${media.url.substring(0, 50)}...`);
      const response = await axios.get(media.url, {
        responseType: 'arraybuffer',
        timeout: 30000
      });
      mediaData = Buffer.from(response.data);
    } else if (media.base64) {
      // Décoder base64
      mediaData = Buffer.from(media.base64, 'base64');
    } else if (media.buffer) {
      mediaData = media.buffer;
    } else {
      throw new Error('Média requis: url, base64, ou buffer');
    }

    // Construire le message selon le type
    switch (media.type) {
      case 'image':
        messageContent = {
          image: mediaData,
          caption: media.caption || ''
        };
        break;

      case 'video':
        messageContent = {
          video: mediaData,
          caption: media.caption || ''
        };
        break;

      case 'audio':
        messageContent = {
          audio: mediaData,
          mimetype: media.mimetype || 'audio/mp4',
          ptt: media.ptt || false  // true = message vocal
        };
        break;

      case 'document':
        messageContent = {
          document: mediaData,
          mimetype: media.mimetype || 'application/pdf',
          fileName: media.fileName || 'document',
          caption: media.caption || ''
        };
        break;

      case 'sticker':
        messageContent = {
          sticker: mediaData
        };
        break;
    }

    const result = await session.socket.sendMessage(jid, messageContent);
    const destination = isLid ? `LID:${lidId}` : phone;
    console.log(`📤 [${salonId}] ${media.type} envoyé à ${destination}`);

    return result;

  } catch (error) {
    console.error(`❌ [${salonId}] Erreur envoi média:`, error.message);
    throw error;
  }
}

function getMessageType(message) {
  if (!message) return 'unknown';
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.imageMessage) return 'image';
  if (message.videoMessage) return 'video';
  if (message.audioMessage) return message.audioMessage.ptt ? 'voice' : 'audio';
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
