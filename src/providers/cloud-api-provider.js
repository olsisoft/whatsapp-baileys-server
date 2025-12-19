/**
 * Cloud API Provider - Official WhatsApp Business Cloud API implementation
 * Primary provider using Meta's Graph API
 */

import { BaseProvider } from './base-provider.js';
import axios from 'axios';

const GRAPH_API_VERSION = 'v18.0';
const GRAPH_API_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export class CloudApiProvider extends BaseProvider {
  constructor(salonId, config = {}, options = {}) {
    super(salonId, config);

    // Cloud API credentials
    this.phoneNumberId = config.phoneNumberId || process.env.CLOUD_API_PHONE_NUMBER_ID;
    this.accessToken = config.accessToken || process.env.CLOUD_API_ACCESS_TOKEN;
    this.businessAccountId = config.businessAccountId || process.env.CLOUD_API_BUSINESS_ACCOUNT_ID;
    this.verifyToken = config.verifyToken || process.env.CLOUD_API_VERIFY_TOKEN;

    // Callbacks
    this.onMessage = options.onMessage || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});

    // Axios instance for API calls
    this.api = axios.create({
      baseURL: `${GRAPH_API_URL}/${this.phoneNumberId}`,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    // Verified business info
    this.verifiedName = null;
  }

  // ═══════════════════════════════════════════
  // CONNECTION MANAGEMENT
  // ═══════════════════════════════════════════

  async connect() {
    if (!this.phoneNumberId || !this.accessToken) {
      throw new Error('Cloud API credentials not configured (CLOUD_API_PHONE_NUMBER_ID, CLOUD_API_ACCESS_TOKEN)');
    }

    this.setStatus('connecting');
    this.onStatusChange({ status: 'connecting' });

    try {
      // Verify credentials by fetching phone number info
      const response = await this.api.get('/', {
        params: {
          fields: 'display_phone_number,verified_name,quality_rating,code_verification_status'
        }
      });

      this.phoneNumber = response.data.display_phone_number;
      this.verifiedName = response.data.verified_name;

      this.setStatus('connected');

      console.log(`[CloudAPI:${this.salonId}] Connected: ${this.verifiedName} (${this.phoneNumber})`);
      console.log(`[CloudAPI:${this.salonId}] Quality: ${response.data.quality_rating || 'N/A'}`);

      this.onStatusChange({
        status: 'connected',
        phoneNumber: this.phoneNumber,
        verifiedName: this.verifiedName
      });

      return {
        success: true,
        status: 'connected',
        phoneNumber: this.phoneNumber,
        verifiedName: this.verifiedName
      };

    } catch (error) {
      const normalizedError = this.normalizeError(error);
      this.setStatus('error');
      this.lastError = normalizedError;

      console.error(`[CloudAPI:${this.salonId}] Connection failed:`, normalizedError.message);

      this.onStatusChange({
        status: 'error',
        error: normalizedError.message
      });

      throw normalizedError;
    }
  }

  async disconnect() {
    // Cloud API doesn't need explicit disconnection
    this.setStatus('disconnected');
    this.phoneNumber = null;
    this.verifiedName = null;

    this.onStatusChange({ status: 'disconnected' });

    console.log(`[CloudAPI:${this.salonId}] Disconnected`);
    return { success: true };
  }

  // ═══════════════════════════════════════════
  // MESSAGE SENDING
  // ═══════════════════════════════════════════

  async sendTextMessage(to, text) {
    const startTime = Date.now();
    const phone = this.formatPhoneNumber(to);

    try {
      const response = await this.api.post('/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: { body: text }
      });

      this.recordSuccess(Date.now() - startTime);

      const messageId = response.data.messages?.[0]?.id;
      console.log(`[CloudAPI:${this.salonId}] Message sent to ${phone}: ${messageId}`);

      return {
        success: true,
        messageId: messageId,
        provider: 'cloud_api'
      };

    } catch (error) {
      this.recordFailure(error);
      throw this.normalizeError(error);
    }
  }

  async sendTemplateMessage(to, templateName, params = [], language = 'fr') {
    const startTime = Date.now();
    const phone = this.formatPhoneNumber(to);

    try {
      // Build template components
      const components = [];

      if (params && params.length > 0) {
        components.push({
          type: 'body',
          parameters: params.map(param => {
            if (typeof param === 'string') {
              return { type: 'text', text: param };
            }
            return param;
          })
        });
      }

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: language }
        }
      };

      if (components.length > 0) {
        payload.template.components = components;
      }

      const response = await this.api.post('/messages', payload);

      this.recordSuccess(Date.now() - startTime);

      const messageId = response.data.messages?.[0]?.id;
      console.log(`[CloudAPI:${this.salonId}] Template '${templateName}' sent to ${phone}: ${messageId}`);

      return {
        success: true,
        messageId: messageId,
        provider: 'cloud_api',
        templateName: templateName
      };

    } catch (error) {
      this.recordFailure(error);
      throw this.normalizeError(error);
    }
  }

  async sendMediaMessage(to, media) {
    const startTime = Date.now();
    const phone = this.formatPhoneNumber(to);

    try {
      let payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: media.type
      };

      switch (media.type) {
        case 'image':
          payload.image = {
            link: media.url,
            caption: media.caption || ''
          };
          break;

        case 'video':
          payload.video = {
            link: media.url,
            caption: media.caption || ''
          };
          break;

        case 'audio':
          payload.audio = {
            link: media.url
          };
          break;

        case 'document':
          payload.document = {
            link: media.url,
            filename: media.fileName || 'document',
            caption: media.caption || ''
          };
          break;

        case 'sticker':
          payload.sticker = {
            link: media.url
          };
          break;

        default:
          throw new Error(`Unsupported media type: ${media.type}`);
      }

      const response = await this.api.post('/messages', payload);

      this.recordSuccess(Date.now() - startTime);

      const messageId = response.data.messages?.[0]?.id;
      console.log(`[CloudAPI:${this.salonId}] ${media.type} sent to ${phone}: ${messageId}`);

      return {
        success: true,
        messageId: messageId,
        provider: 'cloud_api'
      };

    } catch (error) {
      this.recordFailure(error);
      throw this.normalizeError(error);
    }
  }

  // ═══════════════════════════════════════════
  // INTERACTIVE MESSAGES
  // ═══════════════════════════════════════════

  async sendButtonMessage(to, body, buttons) {
    const phone = this.formatPhoneNumber(to);

    try {
      const response = await this.api.post('/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: {
            buttons: buttons.map((btn, index) => ({
              type: 'reply',
              reply: {
                id: btn.id || `btn_${index}`,
                title: btn.title
              }
            }))
          }
        }
      });

      return {
        success: true,
        messageId: response.data.messages?.[0]?.id,
        provider: 'cloud_api'
      };

    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async sendListMessage(to, body, buttonText, sections) {
    const phone = this.formatPhoneNumber(to);

    try {
      const response = await this.api.post('/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: body },
          action: {
            button: buttonText,
            sections: sections
          }
        }
      });

      return {
        success: true,
        messageId: response.data.messages?.[0]?.id,
        provider: 'cloud_api'
      };

    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  // ═══════════════════════════════════════════
  // WEBHOOK HANDLING
  // ═══════════════════════════════════════════

  /**
   * Verify webhook (GET request from Meta)
   */
  verifyWebhook(mode, token, challenge) {
    if (mode === 'subscribe' && token === this.verifyToken) {
      console.log(`[CloudAPI:${this.salonId}] Webhook verified`);
      return challenge;
    }
    throw new Error('Webhook verification failed');
  }

  /**
   * Process incoming webhook payload
   */
  processWebhook(body) {
    if (body.object !== 'whatsapp_business_account') {
      return null;
    }

    const results = [];

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;

        // Process messages
        for (const message of value.messages || []) {
          const contact = value.contacts?.find(c => c.wa_id === message.from);
          const normalized = this.normalizeIncomingMessage(message, contact, value.metadata);
          if (normalized) {
            results.push(normalized);
            this.onMessage(normalized);
          }
        }

        // Process status updates (delivered, read, etc.)
        for (const status of value.statuses || []) {
          this.handleStatusUpdate(status);
        }
      }
    }

    return results;
  }

  handleStatusUpdate(status) {
    console.log(`[CloudAPI:${this.salonId}] Status update: ${status.id} -> ${status.status}`);
    // Can be extended to emit events or update database
  }

  normalizeIncomingMessage(message, contact, metadata) {
    if (!message) return null;

    const content = this.extractContent(message);

    return {
      provider: 'cloud_api',
      salonId: this.salonId,
      messageId: message.id,
      from: message.from,
      resolvedPhone: `+${message.from}`,
      isLid: false,
      lidId: null,
      timestamp: parseInt(message.timestamp),
      type: message.type,
      content: content,
      pushName: contact?.profile?.name || null,
      isVoiceMessage: message.type === 'audio' && message.audio?.voice,
      voiceTranscription: null, // Cloud API doesn't provide transcription
      voiceDurationSeconds: null,
      // Additional Cloud API specific fields
      context: message.context || null, // Reply context
      referral: message.referral || null // Ad referral
    };
  }

  extractContent(message) {
    switch (message.type) {
      case 'text':
        return message.text?.body || '';

      case 'image':
        return message.image?.caption || '[Image]';

      case 'video':
        return message.video?.caption || '[Video]';

      case 'audio':
        return '[Audio]';

      case 'document':
        return message.document?.filename || '[Document]';

      case 'location':
        const loc = message.location;
        return `[Location: ${loc?.latitude}, ${loc?.longitude}]`;

      case 'contacts':
        const contact = message.contacts?.[0];
        return `[Contact: ${contact?.name?.formatted_name || 'Unknown'}]`;

      case 'sticker':
        return '[Sticker]';

      case 'interactive':
        // Button or list reply
        if (message.interactive?.type === 'button_reply') {
          return message.interactive.button_reply?.title || '[Button Reply]';
        }
        if (message.interactive?.type === 'list_reply') {
          return message.interactive.list_reply?.title || '[List Reply]';
        }
        return '[Interactive]';

      case 'button':
        return message.button?.text || '[Button]';

      case 'order':
        return '[Order]';

      case 'reaction':
        return `[Reaction: ${message.reaction?.emoji}]`;

      default:
        return '[Unknown message type]';
    }
  }

  // ═══════════════════════════════════════════
  // MEDIA DOWNLOAD
  // ═══════════════════════════════════════════

  async downloadMedia(mediaId) {
    try {
      // First, get the media URL
      const mediaResponse = await axios.get(
        `${GRAPH_API_URL}/${mediaId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`
          }
        }
      );

      const mediaUrl = mediaResponse.data.url;

      // Then download the actual media
      const downloadResponse = await axios.get(mediaUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        },
        responseType: 'arraybuffer'
      });

      return {
        buffer: Buffer.from(downloadResponse.data),
        mimeType: mediaResponse.data.mime_type,
        sha256: mediaResponse.data.sha256,
        fileSize: mediaResponse.data.file_size
      };

    } catch (error) {
      console.error(`[CloudAPI:${this.salonId}] Media download failed:`, error.message);
      throw this.normalizeError(error);
    }
  }

  // ═══════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════

  formatPhoneNumber(phone) {
    if (!phone) return '';

    // If it's an object, extract phone number
    if (typeof phone === 'object') {
      phone = phone.phoneNumber || phone.to || '';
    }

    // Remove all non-digit characters except leading +
    return phone.replace(/[^\d]/g, '');
  }

  normalizeError(error) {
    // Cloud API error structure
    const cloudError = error.response?.data?.error || {};
    const statusCode = error.response?.status;

    // Map Cloud API error codes
    const errorCode = cloudError.code || statusCode || 'UNKNOWN';

    return {
      code: errorCode,
      message: cloudError.message || error.message || 'Unknown Cloud API error',
      isRateLimit: errorCode === 130429 || errorCode === 80007,
      isTemplateError: [132000, 132001, 132005, 132007, 132012, 132015].includes(errorCode),
      isInvalidPhone: [131026, 131047, 131051].includes(errorCode),
      isAuthError: statusCode === 401 || errorCode === 190,
      retryable: this.isRetryableError(errorCode, statusCode),
      errorSubcode: cloudError.error_subcode,
      fbTraceId: cloudError.fbtrace_id,
      originalError: error
    };
  }

  isRetryableError(code, statusCode) {
    // Rate limit - retry after delay
    if (code === 130429 || code === 80007) return true;

    // Server errors - retry
    if (statusCode >= 500) return true;

    // Timeout - retry
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return true;

    // Most other errors are not retryable
    return false;
  }

  // ═══════════════════════════════════════════
  // GETTERS
  // ═══════════════════════════════════════════

  getVerifiedName() {
    return this.verifiedName;
  }

  getPhoneNumberId() {
    return this.phoneNumberId;
  }

  getBusinessAccountId() {
    return this.businessAccountId;
  }

  supportsTemplates() {
    return true;
  }
}

export default CloudApiProvider;
