/**
 * Hybrid Session Manager - Manages WhatsApp sessions with multiple providers
 * Supports Cloud API as primary with Baileys fallback
 */

import { ProviderFactory } from './providers/provider-factory.js';
import { loadConfig, getFallbackConfig, shouldTriggerFallback } from './config/provider-config.js';
import axios from 'axios';
import {
  enqueue,
  dequeue,
  incrementAttempts,
  getQueuedMessages,
  cleanupFailedMessages,
  getQueueLength
} from './queue.js';

// Load configuration
const config = loadConfig();

// Session storage
const sessions = new Map();
const statusCallbacks = new Map();
const pollingIntervals = new Map();

// Environment variables
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL) || 5000;

/**
 * Session structure:
 * {
 *   salonId: string,
 *   config: object,
 *   providers: Map<string, BaseProvider>,
 *   activeProvider: string,
 *   status: string,
 *   phoneNumber: string,
 *   connectedAt: string,
 *   qrCode: string
 * }
 */

// ═══════════════════════════════════════════
// SESSION GETTERS
// ═══════════════════════════════════════════

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
      connectedAt: session.connectedAt,
      activeProvider: session.activeProvider,
      providerStatuses: getProviderStatuses(session)
    });
  }
  return result;
}

function getProviderStatuses(session) {
  const statuses = {};
  for (const [name, provider] of session.providers) {
    statuses[name] = {
      status: provider.getStatus(),
      isHealthy: provider.isHealthy(),
      healthMetrics: provider.getHealthMetrics()
    };
  }
  return statuses;
}

// ═══════════════════════════════════════════
// STATUS CALLBACKS
// ═══════════════════════════════════════════

export function onStatusChange(salonId, callback) {
  if (!statusCallbacks.has(salonId)) {
    statusCallbacks.set(salonId, []);
  }
  statusCallbacks.get(salonId).push(callback);

  // Return unsubscribe function
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
      console.error('Status callback error:', e);
    }
  }
}

// ═══════════════════════════════════════════
// SESSION CREATION
// ═══════════════════════════════════════════

export async function createSession(salonId, sessionConfig = null) {
  const existing = sessions.get(salonId);
  if (existing && existing.status === 'connected') {
    console.log(`[${salonId}] Session already connected via ${existing.activeProvider}`);
    return existing;
  }

  // Use provided config or load from environment
  const mergedConfig = { ...config, ...(sessionConfig || {}) };

  // Get available providers
  const providerPriority = ProviderFactory.getProviderPriority(mergedConfig);
  console.log(`[${salonId}] Provider priority: ${providerPriority.join(' > ')}`);

  if (providerPriority.length === 0) {
    throw new Error('No providers available. Check configuration.');
  }

  const session = {
    salonId,
    config: mergedConfig,
    providers: new Map(),
    activeProvider: null,
    status: 'initializing',
    phoneNumber: null,
    connectedAt: null,
    qrCode: null,
    qrCodeBase64: null
  };

  sessions.set(salonId, session);
  notifyStatusChange(salonId, { status: 'initializing' });

  // Try each provider in priority order
  for (const providerType of providerPriority) {
    try {
      console.log(`[${salonId}] Trying ${providerType}...`);

      const provider = ProviderFactory.create(providerType, salonId, mergedConfig, {
        onQrCode: (qr) => handleQrCode(salonId, qr),
        onMessage: (msg) => handleIncomingMessage(salonId, msg),
        onStatusChange: (data) => handleProviderStatusChange(salonId, providerType, data)
      });

      session.providers.set(providerType, provider);

      const result = await provider.connect();

      if (result.status === 'connected') {
        session.activeProvider = providerType;
        session.status = 'connected';
        session.phoneNumber = result.phoneNumber;
        session.connectedAt = new Date().toISOString();

        console.log(`[${salonId}] Connected via ${providerType}`);
        notifyStatusChange(salonId, {
          status: 'connected',
          provider: providerType,
          phoneNumber: session.phoneNumber
        });

        startPolling(salonId);
        setTimeout(() => processQueue(), 2000);
        break;

      } else if (result.status === 'qr_ready') {
        // Baileys waiting for QR scan
        session.status = 'qr_ready';
        session.qrCodeBase64 = result.qrCode;
        console.log(`[${salonId}] QR code ready via ${providerType}`);
        // Don't break - wait for connection
        break;
      }

    } catch (error) {
      console.warn(`[${salonId}] ${providerType} failed:`, error.message);
      // Continue to next provider
    }
  }

  return session;
}

function handleQrCode(salonId, qrCode) {
  const session = sessions.get(salonId);
  if (session) {
    session.qrCodeBase64 = qrCode;
    session.status = 'qr_ready';
    notifyStatusChange(salonId, {
      status: 'qr_ready',
      qrCode: qrCode
    });
  }
}

function handleProviderStatusChange(salonId, providerType, data) {
  const session = sessions.get(salonId);
  if (!session) return;

  // Provider became connected
  if (data.status === 'connected' && !session.activeProvider) {
    session.activeProvider = providerType;
    session.status = 'connected';
    session.phoneNumber = data.phoneNumber;
    session.connectedAt = new Date().toISOString();
    session.qrCodeBase64 = null;

    console.log(`[${salonId}] Connected via ${providerType}`);
    startPolling(salonId);
    setTimeout(() => processQueue(), 2000);
  }

  notifyStatusChange(salonId, { ...data, provider: providerType });
}

// ═══════════════════════════════════════════
// MESSAGE SENDING (WITH FALLBACK)
// ═══════════════════════════════════════════

export async function sendMessage(salonId, phone, content, options = {}) {
  const session = sessions.get(salonId);
  if (!session) {
    throw new Error('Session not found');
  }

  const { isLid = false, lidId = null, templateName = null, templateParams = null, language = 'fr' } = options;

  // Build provider order
  let providerOrder = [
    session.activeProvider,
    ...session.config.providerPriority.filter(p => p !== session.activeProvider)
  ].filter(Boolean);

  // Force Cloud API for templates
  if (templateName) {
    const cloudApiIndex = providerOrder.indexOf('cloud_api');
    if (cloudApiIndex > 0) {
      providerOrder = ['cloud_api', ...providerOrder.filter(p => p !== 'cloud_api')];
    }
    if (!providerOrder.includes('cloud_api')) {
      throw new Error('Templates require Cloud API provider');
    }
  }

  const fallbackConfig = getFallbackConfig(session.config);
  let lastError = null;
  let attempts = 0;

  for (const providerName of providerOrder) {
    const provider = session.providers.get(providerName);
    if (!provider) continue;

    // Skip unhealthy providers (except if it's the only one)
    if (!provider.isHealthy() && providerOrder.length > 1) {
      console.log(`[${salonId}] Skipping unhealthy provider: ${providerName}`);
      continue;
    }

    const maxRetries = fallbackConfig.enabled ? fallbackConfig.maxRetries : 1;

    for (let retry = 0; retry < maxRetries; retry++) {
      attempts++;

      try {
        let result;

        if (templateName) {
          result = await provider.sendTemplateMessage(phone, templateName, templateParams, language);
        } else {
          result = await provider.sendTextMessage(phone, content);
        }

        console.log(`[${salonId}] Message sent via ${providerName}`);
        return result;

      } catch (error) {
        lastError = error;
        console.warn(`[${salonId}] Send failed (${providerName}, attempt ${retry + 1}):`, error.message);

        // Check if we should fallback
        if (shouldTriggerFallback(error, fallbackConfig)) {
          console.log(`[${salonId}] Triggering fallback to next provider...`);
          break; // Try next provider
        }

        // Wait before retry (if retryable)
        if (error.retryable && retry < maxRetries - 1) {
          await sleep(fallbackConfig.retryDelayMs * (retry + 1));
        } else if (!error.retryable) {
          break; // Don't retry non-retryable errors
        }
      }
    }
  }

  // All providers failed
  console.error(`[${salonId}] All providers failed after ${attempts} attempts`);
  throw lastError || new Error('All providers failed to send message');
}

export async function sendTemplateMessage(salonId, phone, templateName, params = [], language = 'fr') {
  return sendMessage(salonId, phone, null, {
    templateName,
    templateParams: params,
    language
  });
}

// ═══════════════════════════════════════════
// INCOMING MESSAGE HANDLING
// ═══════════════════════════════════════════

async function handleIncomingMessage(salonId, normalizedMessage) {
  const messageData = { ...normalizedMessage, salonId };

  console.log(`[${salonId}] Incoming message from ${messageData.resolvedPhone || messageData.lidId}`);

  await forwardToWebhook(salonId, messageData);
}

async function forwardToWebhook(salonId, messageData, fromQueue = false) {
  if (!WEBHOOK_URL) {
    console.warn('WEBHOOK_URL not configured');
    return false;
  }

  // Unified webhook payload
  const payload = {
    type: 'message',
    salonId: salonId,
    phone: messageData.resolvedPhone,
    message: messageData.content,
    customerName: messageData.pushName || null,
    whatsappMessageId: messageData.messageId,
    isLid: messageData.isLid || false,
    lidId: messageData.lidId || null,
    isVoiceMessage: messageData.isVoiceMessage || false,
    voiceTranscription: messageData.voiceTranscription || null,
    voiceDurationSeconds: messageData.voiceDurationSeconds || null,
    provider: messageData.provider // 'cloud_api' or 'baileys'
  };

  console.log(`[${salonId}] Sending webhook ${fromQueue ? '(retry)' : ''}`);

  try {
    const response = await axios.post(WEBHOOK_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    console.log(`[${salonId}] Webhook OK - Status: ${response.status}`);

    if (fromQueue) {
      dequeue(messageData.messageId);
    }

    return true;

  } catch (error) {
    console.error(`[${salonId}] Webhook error: ${error.message}`);

    if (error.response?.status === 400) {
      console.log(`[${salonId}] Error 400 - message ignored`);
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

  console.log(`Processing ${queuedMessages.length} queued messages...`);

  for (const msg of queuedMessages) {
    await forwardToWebhook(msg.salonId, msg, true);
    await sleep(500);
  }

  cleanupFailedMessages();

  const remaining = getQueueLength();
  if (remaining > 0) {
    console.log(`${remaining} messages still in queue`);
  }
}

// ═══════════════════════════════════════════
// POLLING (OUTGOING MESSAGES FROM SUPABASE)
// ═══════════════════════════════════════════

function startPolling(salonId) {
  stopPolling(salonId);

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn(`[${salonId}] Polling disabled - Supabase not configured`);
    return;
  }

  console.log(`[${salonId}] Starting polling (interval: ${POLLING_INTERVAL}ms)`);

  const intervalId = setInterval(async () => {
    await pollPendingMessages(salonId);
  }, POLLING_INTERVAL);

  pollingIntervals.set(salonId, intervalId);
}

function stopPolling(salonId) {
  const intervalId = pollingIntervals.get(salonId);
  if (intervalId) {
    clearInterval(intervalId);
    pollingIntervals.delete(salonId);
    console.log(`[${salonId}] Polling stopped`);
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

    console.log(`[${salonId}] ${count || messages.length} message(s) to send`);

    for (const msg of messages) {
      try {
        const result = await sendMessage(salonId, msg.phoneNumber, msg.content, {
          isLid: msg.isLid,
          lidId: msg.lidId
        });

        console.log(`[${salonId}] Message sent to ${msg.phoneNumber}`);
        await markMessageSent([msg.id], 'sent', result?.messageId);

      } catch (sendError) {
        console.error(`[${salonId}] Send error:`, sendError.message);
        await markMessageSent([msg.id], 'failed', null, sendError.message);
      }
    }

  } catch (error) {
    if (!error.message.includes('timeout') && !error.message.includes('ECONNREFUSED')) {
      console.error(`[${salonId}] Polling error:`, error.message);
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
  } catch (error) {
    console.error('Error marking message:', error.message);
  }
}

// ═══════════════════════════════════════════
// SESSION DISCONNECTION
// ═══════════════════════════════════════════

export async function disconnectSession(salonId) {
  const session = sessions.get(salonId);
  if (!session) return false;

  stopPolling(salonId);

  // Disconnect all providers
  for (const [name, provider] of session.providers) {
    try {
      await provider.disconnect();
      console.log(`[${salonId}] ${name} disconnected`);
    } catch (e) {
      console.error(`[${salonId}] Error disconnecting ${name}:`, e);
    }
  }

  sessions.delete(salonId);
  notifyStatusChange(salonId, { status: 'disconnected' });

  console.log(`[${salonId}] Session disconnected`);
  return true;
}

// ═══════════════════════════════════════════
// AUTO-RECONNECT ON STARTUP
// ═══════════════════════════════════════════

export async function reconnectExistingSessions() {
  const fs = await import('fs');
  const authDir = './auth';

  if (!fs.existsSync(authDir)) {
    console.log('No existing sessions to reconnect');
    return;
  }

  const salonIds = fs.readdirSync(authDir).filter(file => {
    return fs.statSync(`${authDir}/${file}`).isDirectory();
  });

  if (salonIds.length === 0) {
    console.log('No existing sessions to reconnect');
    return;
  }

  console.log(`Reconnecting ${salonIds.length} existing session(s)...`);

  for (const salonId of salonIds) {
    try {
      await createSession(salonId);
      await sleep(2000); // Delay between reconnections
    } catch (error) {
      console.error(`Failed to reconnect ${salonId}:`, error.message);
    }
  }
}

// ═══════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════
// CLOUD API WEBHOOK HANDLER
// ═══════════════════════════════════════════

export function handleCloudApiWebhook(body) {
  // Find the session by phone number ID
  const entry = body.entry?.[0];
  const phoneNumberId = entry?.changes?.[0]?.value?.metadata?.phone_number_id;

  if (!phoneNumberId) {
    console.warn('No phone_number_id in webhook');
    return null;
  }

  // Find session with matching Cloud API provider
  for (const [salonId, session] of sessions) {
    const cloudProvider = session.providers.get('cloud_api');
    if (cloudProvider && cloudProvider.getPhoneNumberId() === phoneNumberId) {
      return cloudProvider.processWebhook(body);
    }
  }

  console.warn(`No session found for phone_number_id: ${phoneNumberId}`);
  return null;
}

export function verifyCloudApiWebhook(mode, token, challenge) {
  const verifyToken = process.env.CLOUD_API_VERIFY_TOKEN || 'whatsapp_webhook_verify';

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('Cloud API webhook verified');
    return challenge;
  }

  throw new Error('Webhook verification failed');
}

// Export for backward compatibility
export { getQueueLength };
