/**
 * Baileys Provider - WhatsApp Web implementation using Baileys library
 * Fallback provider using QR code authentication
 */

import { BaseProvider } from './base-provider.js';
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
import OpenAI from 'openai';

const logger = pino({ level: 'silent' });

// OpenAI client for voice transcription
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Temp directory for audio files
const TEMP_DIR = './temp';
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

export class BaileysProvider extends BaseProvider {
  constructor(salonId, config = {}, options = {}) {
    super(salonId, config);

    this.authDir = path.join('./auth', salonId);
    this.socket = null;
    this.qrCode = null;
    this.qrCodeBase64 = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
    this.saveCreds = null;
    this.reconnectTimer = null;
    this.eventHandlers = new Map(); // Track event handlers for cleanup

    // Callbacks
    this.onQrCode = options.onQrCode || (() => {});
    this.onMessage = options.onMessage || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});

    // Connection promise resolvers
    this.connectionResolver = null;
    this.connectionRejecter = null;
  }

  // ═══════════════════════════════════════════
  // CONNECTION MANAGEMENT
  // ═══════════════════════════════════════════

  async connect() {
    // Create auth directory if needed
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }

    this.setStatus('connecting');
    this.onStatusChange({ status: 'connecting' });

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      this.saveCreds = saveCreds;

      const { version } = await fetchLatestBaileysVersion();

      this.socket = makeWASocket({
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

      this.setupEventHandlers();

      // Return a promise that resolves when connected or rejects on failure
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (this.status !== 'connected' && this.status !== 'qr_ready') {
            reject(new Error('Connection timeout'));
          }
        }, 60000);

        this.connectionResolver = (result) => {
          clearTimeout(timeout);
          resolve(result);
        };

        this.connectionRejecter = (error) => {
          clearTimeout(timeout);
          reject(error);
        };

        // If QR is ready, resolve with qr_ready status
        if (this.status === 'qr_ready') {
          clearTimeout(timeout);
          resolve({ success: true, status: 'qr_ready' });
        }
      });

    } catch (error) {
      this.setStatus('error');
      this.lastError = error;
      this.onStatusChange({ status: 'error', error: error.message });
      throw error;
    }
  }

  setupEventHandlers() {
    // Clean up any existing handlers first
    this.cleanupEventHandlers();

    // Connection updates
    const connectionHandler = async (update) => {
      await this.handleConnectionUpdate(update);
    };
    this.socket.ev.on('connection.update', connectionHandler);
    this.eventHandlers.set('connection.update', connectionHandler);

    // Credentials update
    const credsHandler = async () => {
      if (this.saveCreds) {
        await this.saveCreds();
      }
    };
    this.socket.ev.on('creds.update', credsHandler);
    this.eventHandlers.set('creds.update', credsHandler);

    // Incoming messages
    const messageHandler = async ({ messages, type }) => {
      await this.handleIncomingMessages(messages, type);
    };
    this.socket.ev.on('messages.upsert', messageHandler);
    this.eventHandlers.set('messages.upsert', messageHandler);
  }

  cleanupEventHandlers() {
    if (this.socket?.ev) {
      for (const [event, handler] of this.eventHandlers.entries()) {
        try {
          this.socket.ev.off(event, handler);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
    this.eventHandlers.clear();
  }

  // Exponential backoff with jitter
  calculateBackoffDelay(attempt) {
    const baseDelay = 1000; // 1 second
    const maxDelay = 60000; // 60 seconds max
    const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    // Add jitter: random value between 0 and 30% of the delay
    const jitter = Math.random() * exponentialDelay * 0.3;
    return Math.floor(exponentialDelay + jitter);
  }

  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    // QR Code ready
    if (qr) {
      this.setStatus('qr_ready');
      this.qrCode = qr;

      try {
        this.qrCodeBase64 = await QRCode.toDataURL(qr, {
          width: 300,
          margin: 2,
          color: { dark: '#000000', light: '#FFFFFF' }
        });
      } catch (e) {
        console.error(`[Baileys:${this.salonId}] QR generation error:`, e);
      }

      console.log(`[Baileys:${this.salonId}] QR code ready`);
      this.onQrCode(this.qrCodeBase64);
      this.onStatusChange({ status: 'qr_ready', qrCode: this.qrCodeBase64 });

      // Resolve connection promise with qr_ready
      if (this.connectionResolver) {
        this.connectionResolver({ success: true, status: 'qr_ready', qrCode: this.qrCodeBase64 });
        this.connectionResolver = null;
      }
    }

    // Connection closed
    if (connection === 'close') {
      this.qrCode = null;
      this.qrCodeBase64 = null;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.output?.payload?.message || 'Unknown';

      console.log(`[Baileys:${this.salonId}] Disconnected - Code: ${statusCode}, Reason: ${reason}`);

      // Logged out
      if (statusCode === DisconnectReason.loggedOut) {
        this.setStatus('logged_out');
        this.phoneNumber = null;
        fs.rmSync(this.authDir, { recursive: true, force: true });
        this.onStatusChange({ status: 'logged_out' });

        if (this.connectionRejecter) {
          this.connectionRejecter(new Error('Logged out'));
          this.connectionRejecter = null;
        }
        return;
      }

      // Bad session - clear auth and reset attempts
      if (statusCode === DisconnectReason.badSession) {
        fs.rmSync(this.authDir, { recursive: true, force: true });
        this.reconnectAttempts = 0;
      }

      // Try to reconnect with exponential backoff
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.setStatus('reconnecting');

        const delay = this.calculateBackoffDelay(this.reconnectAttempts);

        this.onStatusChange({
          status: 'reconnecting',
          attempt: this.reconnectAttempts,
          maxAttempts: this.maxReconnectAttempts,
          nextRetryIn: delay
        });

        console.log(`[Baileys:${this.salonId}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        // Clear any existing reconnect timer
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect().catch(err => {
            console.error(`[Baileys:${this.salonId}] Reconnect failed:`, err.message);
          });
        }, delay);
      } else {
        this.setStatus('failed');
        this.onStatusChange({ status: 'failed', reason: 'Max reconnection attempts reached' });

        if (this.connectionRejecter) {
          this.connectionRejecter(new Error('Max reconnection attempts reached'));
          this.connectionRejecter = null;
        }
      }
    }

    // Connection open
    if (connection === 'open') {
      this.setStatus('connected');
      this.qrCode = null;
      this.qrCodeBase64 = null;
      this.reconnectAttempts = 0;

      // Extract phone number
      const rawId = this.socket.user?.id || '';
      this.phoneNumber = rawId.split(':')[0].split('@')[0];

      console.log(`[Baileys:${this.salonId}] Connected! Phone: ${this.phoneNumber}`);

      if (openai) {
        console.log(`[Baileys:${this.salonId}] Voice transcription: ENABLED`);
      } else {
        console.log(`[Baileys:${this.salonId}] Voice transcription: DISABLED`);
      }

      this.onStatusChange({
        status: 'connected',
        phoneNumber: this.phoneNumber
      });

      if (this.connectionResolver) {
        this.connectionResolver({
          success: true,
          status: 'connected',
          phoneNumber: this.phoneNumber
        });
        this.connectionResolver = null;
      }
    }
  }

  async disconnect() {
    // Clear reconnect timer if pending
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Clean up event handlers to prevent memory leaks
    this.cleanupEventHandlers();

    try {
      if (this.socket) {
        await this.socket.logout();
      }
    } catch (e) {
      console.error(`[Baileys:${this.salonId}] Logout error:`, e.message);
    }

    // Clear auth directory
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    } catch (e) {
      console.error(`[Baileys:${this.salonId}] Auth cleanup error:`, e.message);
    }

    this.setStatus('disconnected');
    this.socket = null;
    this.phoneNumber = null;
    this.qrCode = null;
    this.qrCodeBase64 = null;
    this.connectionResolver = null;
    this.connectionRejecter = null;
    this.reconnectAttempts = 0;

    this.onStatusChange({ status: 'disconnected' });

    console.log(`[Baileys:${this.salonId}] Disconnected and cleaned up`);
    return { success: true };
  }

  // ═══════════════════════════════════════════
  // MESSAGE SENDING
  // ═══════════════════════════════════════════

  async sendTextMessage(to, text) {
    if (!this.socket || this.status !== 'connected') {
      throw this.normalizeError(new Error('Not connected'));
    }

    const startTime = Date.now();
    const jid = this.buildJid(to);

    if (!jid) {
      throw this.normalizeError(new Error('Invalid phone number or JID'));
    }

    try {
      const result = await this.socket.sendMessage(jid, { text });

      this.recordSuccess(Date.now() - startTime);

      console.log(`[Baileys:${this.salonId}] Message sent to ${to}`);

      return {
        success: true,
        messageId: result?.key?.id,
        provider: 'baileys'
      };
    } catch (error) {
      this.recordFailure(error);
      throw this.normalizeError(error);
    }
  }

  async sendTemplateMessage(to, templateName, params = [], language = 'fr') {
    // Baileys does not support WhatsApp Business templates
    throw {
      code: 'TEMPLATE_NOT_SUPPORTED',
      message: 'Baileys does not support template messages. Use Cloud API for templates.',
      isTemplateError: true,
      retryable: false
    };
  }

  async sendMediaMessage(to, media) {
    if (!this.socket || this.status !== 'connected') {
      throw this.normalizeError(new Error('Not connected'));
    }

    const startTime = Date.now();
    const jid = this.buildJid(to);

    if (!jid) {
      throw this.normalizeError(new Error('Invalid phone number or JID'));
    }

    try {
      let messageContent = {};

      switch (media.type) {
        case 'image':
          messageContent = {
            image: { url: media.url },
            caption: media.caption || ''
          };
          break;
        case 'video':
          messageContent = {
            video: { url: media.url },
            caption: media.caption || ''
          };
          break;
        case 'audio':
          messageContent = {
            audio: { url: media.url },
            ptt: media.ptt || false
          };
          break;
        case 'document':
          messageContent = {
            document: { url: media.url },
            fileName: media.fileName || 'document',
            mimetype: media.mimetype || 'application/octet-stream'
          };
          break;
        default:
          throw new Error(`Unsupported media type: ${media.type}`);
      }

      const result = await this.socket.sendMessage(jid, messageContent);

      this.recordSuccess(Date.now() - startTime);

      return {
        success: true,
        messageId: result?.key?.id,
        provider: 'baileys'
      };
    } catch (error) {
      this.recordFailure(error);
      throw this.normalizeError(error);
    }
  }

  // ═══════════════════════════════════════════
  // INCOMING MESSAGES
  // ═══════════════════════════════════════════

  async handleIncomingMessages(messages, type) {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      try {
        const normalized = await this.processIncomingMessage(msg);
        if (normalized) {
          this.onMessage(normalized);
        }
      } catch (error) {
        console.error(`[Baileys:${this.salonId}] Error processing message:`, error);
      }
    }
  }

  async processIncomingMessage(msg) {
    const remoteJid = msg.key.remoteJid || '';
    const extracted = this.extractPhoneFromJid(remoteJid);

    let content = '';
    let messageType = 'unknown';
    let isVoiceMessage = false;
    let voiceTranscription = null;
    let voiceDurationSeconds = null;

    // Voice message processing
    if (msg.message?.audioMessage?.ptt) {
      isVoiceMessage = true;
      voiceDurationSeconds = msg.message.audioMessage.seconds || 0;
      messageType = 'voice';

      console.log(`[Baileys:${this.salonId}] Voice message received (${voiceDurationSeconds}s)`);

      try {
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          {
            logger,
            reuploadRequest: this.socket.updateMediaMessage
          }
        );

        if (openai) {
          voiceTranscription = await this.transcribeAudio(buffer, msg.key.id);
          content = voiceTranscription || '[Voice message - transcription failed]';
        } else {
          content = '[Voice message - transcription not configured]';
        }
      } catch (downloadError) {
        console.error(`[Baileys:${this.salonId}] Audio download error:`, downloadError.message);
        content = '[Voice message - download error]';
      }
    } else {
      content = this.extractMessageContent(msg.message);
      messageType = this.getMessageType(msg.message);
    }

    return {
      provider: 'baileys',
      salonId: this.salonId,
      messageId: msg.key.id,
      from: remoteJid,
      resolvedPhone: extracted.phone,
      isLid: extracted.isLid,
      lidId: extracted.lidId,
      timestamp: msg.messageTimestamp,
      type: messageType,
      content: content,
      pushName: msg.pushName || null,
      isVoiceMessage: isVoiceMessage,
      voiceTranscription: voiceTranscription,
      voiceDurationSeconds: voiceDurationSeconds
    };
  }

  normalizeIncomingMessage(rawMessage) {
    // This is called with already processed message data
    return rawMessage;
  }

  // ═══════════════════════════════════════════
  // VOICE TRANSCRIPTION
  // ═══════════════════════════════════════════

  async transcribeAudio(audioBuffer, messageId) {
    if (!openai) {
      console.warn(`[Baileys:${this.salonId}] OpenAI not configured`);
      return null;
    }

    const tempPath = path.join(TEMP_DIR, `voice-${messageId}.ogg`);

    try {
      fs.writeFileSync(tempPath, audioBuffer);

      console.log(`[Baileys:${this.salonId}] Transcribing audio...`);

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempPath),
        model: 'whisper-1',
        language: 'fr'
      });

      console.log(`[Baileys:${this.salonId}] Transcription: "${transcription.text.substring(0, 50)}..."`);

      return transcription.text;
    } catch (error) {
      console.error(`[Baileys:${this.salonId}] Transcription error:`, error.message);
      return null;
    } finally {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  // ═══════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════

  buildJid(to) {
    if (!to) return null;

    // Already a JID
    if (typeof to === 'string' && to.includes('@')) {
      return to;
    }

    // Object with isLid
    if (typeof to === 'object') {
      if (to.isLid && to.lidId) {
        return `${to.lidId}@lid`;
      }
      if (to.phoneNumber) {
        const cleanPhone = to.phoneNumber.replace(/[+\s-]/g, '');
        return `${cleanPhone}@s.whatsapp.net`;
      }
      return null;
    }

    // Phone number string
    const cleanPhone = to.replace(/[+\s-]/g, '');
    return `${cleanPhone}@s.whatsapp.net`;
  }

  extractPhoneFromJid(jid) {
    if (!jid) {
      return { phone: null, isLid: false, lidId: null };
    }

    if (jid.includes('@lid')) {
      const lidNumber = jid.replace('@lid', '');
      return { phone: null, isLid: true, lidId: lidNumber };
    }

    const match = jid.match(/^(\d+)@s\.whatsapp\.net$/);
    if (match) {
      const digits = match[1];

      if (digits.length >= 8 && digits.length <= 15) {
        return { phone: `+${digits}`, isLid: false, lidId: null };
      } else {
        return { phone: null, isLid: true, lidId: digits };
      }
    }

    return { phone: null, isLid: false, lidId: null };
  }

  getMessageType(message) {
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

  extractMessageContent(message) {
    if (!message) return '';
    return message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      '[Media]';
  }

  normalizeError(error) {
    return {
      code: error.code || 'BAILEYS_ERROR',
      message: error.message || 'Unknown Baileys error',
      isRateLimit: false,
      isTemplateError: false,
      isInvalidPhone: error.message?.includes('not registered') || error.message?.includes('invalid'),
      retryable: !error.message?.includes('not registered'),
      originalError: error
    };
  }

  // ═══════════════════════════════════════════
  // GETTERS
  // ═══════════════════════════════════════════

  getSocket() {
    return this.socket;
  }

  getQrCode() {
    return this.qrCodeBase64;
  }

  hasCredentials() {
    return fs.existsSync(path.join(this.authDir, 'creds.json'));
  }
}

export default BaileysProvider;
