/**
 * Base Provider - Abstract class for WhatsApp messaging providers
 * All providers (Cloud API, Baileys) must extend this class
 */

export class BaseProvider {
  constructor(salonId, config = {}) {
    if (new.target === BaseProvider) {
      throw new Error('BaseProvider is abstract and cannot be instantiated directly');
    }

    this.salonId = salonId;
    this.config = config;
    this.status = 'disconnected';
    this.lastError = null;
    this.phoneNumber = null;

    // Health metrics for monitoring
    this.healthMetrics = {
      successCount: 0,
      failureCount: 0,
      lastSuccess: null,
      lastFailure: null,
      avgResponseTime: 0,
      totalResponseTime: 0
    };
  }

  // ═══════════════════════════════════════════
  // ABSTRACT METHODS - Must be implemented
  // ═══════════════════════════════════════════

  /**
   * Connect to the WhatsApp service
   * @returns {Promise<{success: boolean, phoneNumber?: string}>}
   */
  async connect() {
    throw new Error('Method connect() must be implemented');
  }

  /**
   * Disconnect from the WhatsApp service
   * @returns {Promise<{success: boolean}>}
   */
  async disconnect() {
    throw new Error('Method disconnect() must be implemented');
  }

  /**
   * Send a text message
   * @param {string} to - Recipient phone number or JID
   * @param {string} text - Message content
   * @returns {Promise<{success: boolean, messageId: string, provider: string}>}
   */
  async sendTextMessage(to, text) {
    throw new Error('Method sendTextMessage() must be implemented');
  }

  /**
   * Send a template message (Cloud API only)
   * @param {string} to - Recipient phone number
   * @param {string} templateName - Template name
   * @param {Array} params - Template parameters
   * @param {string} language - Language code (default: 'fr')
   * @returns {Promise<{success: boolean, messageId: string, provider: string}>}
   */
  async sendTemplateMessage(to, templateName, params = [], language = 'fr') {
    throw new Error('Method sendTemplateMessage() must be implemented');
  }

  /**
   * Send a media message
   * @param {string} to - Recipient phone number or JID
   * @param {object} media - Media object with type, url, caption
   * @returns {Promise<{success: boolean, messageId: string, provider: string}>}
   */
  async sendMediaMessage(to, media) {
    throw new Error('Method sendMediaMessage() must be implemented');
  }

  /**
   * Normalize incoming message to unified format
   * @param {object} rawMessage - Provider-specific message format
   * @returns {object} Normalized message object
   */
  normalizeIncomingMessage(rawMessage) {
    throw new Error('Method normalizeIncomingMessage() must be implemented');
  }

  // ═══════════════════════════════════════════
  // STATUS METHODS
  // ═══════════════════════════════════════════

  /**
   * Get current provider status
   * @returns {string} Status: 'disconnected', 'connecting', 'qr_ready', 'connected', 'error'
   */
  getStatus() {
    return this.status;
  }

  /**
   * Set provider status
   * @param {string} status - New status
   */
  setStatus(status) {
    this.status = status;
  }

  /**
   * Get phone number associated with this provider
   * @returns {string|null}
   */
  getPhoneNumber() {
    return this.phoneNumber;
  }

  /**
   * Check if provider is connected and ready
   * @returns {boolean}
   */
  isConnected() {
    return this.status === 'connected';
  }

  // ═══════════════════════════════════════════
  // HEALTH METRICS
  // ═══════════════════════════════════════════

  /**
   * Get health metrics
   * @returns {object} Health metrics object
   */
  getHealthMetrics() {
    return { ...this.healthMetrics };
  }

  /**
   * Check if provider is healthy based on recent success rate
   * @param {number} threshold - Failure rate threshold (default: 0.3 = 30%)
   * @returns {boolean}
   */
  isHealthy(threshold = 0.3) {
    if (this.status !== 'connected') {
      return false;
    }

    const total = this.healthMetrics.successCount + this.healthMetrics.failureCount;
    if (total === 0) {
      return true; // No data yet, assume healthy
    }

    const failureRate = this.healthMetrics.failureCount / total;
    return failureRate < threshold;
  }

  /**
   * Record a successful operation
   * @param {number} responseTime - Response time in milliseconds
   */
  recordSuccess(responseTime = 0) {
    this.healthMetrics.successCount++;
    this.healthMetrics.lastSuccess = Date.now();
    this.healthMetrics.totalResponseTime += responseTime;
    this.healthMetrics.avgResponseTime =
      this.healthMetrics.totalResponseTime / this.healthMetrics.successCount;
  }

  /**
   * Record a failed operation
   * @param {Error|object} error - Error object
   */
  recordFailure(error) {
    this.healthMetrics.failureCount++;
    this.healthMetrics.lastFailure = Date.now();
    this.lastError = error;
  }

  /**
   * Reset health metrics
   */
  resetHealthMetrics() {
    this.healthMetrics = {
      successCount: 0,
      failureCount: 0,
      lastSuccess: null,
      lastFailure: null,
      avgResponseTime: 0,
      totalResponseTime: 0
    };
  }

  // ═══════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════

  /**
   * Normalize outgoing message format
   * @param {object} message - Message object
   * @returns {object} Normalized message
   */
  normalizeOutgoingMessage(message) {
    return {
      to: message.phoneNumber || message.to,
      isLid: message.isLid || false,
      lidId: message.lidId || null,
      type: message.type || 'text',
      content: message.content || message.text || message.message,
      mediaUrl: message.mediaUrl || null,
      templateName: message.templateName || null,
      templateParams: message.templateParams || null,
      language: message.language || 'fr'
    };
  }

  /**
   * Normalize error to standard format
   * @param {Error|object} error - Error object
   * @returns {object} Normalized error
   */
  normalizeError(error) {
    return {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message || 'An unknown error occurred',
      isRateLimit: false,
      isTemplateError: false,
      isInvalidPhone: false,
      retryable: true,
      originalError: error
    };
  }

  /**
   * Get provider name
   * @returns {string}
   */
  getProviderName() {
    return this.constructor.name.replace('Provider', '').toLowerCase();
  }

  /**
   * Get provider info for debugging/logging
   * @returns {object}
   */
  getInfo() {
    return {
      salonId: this.salonId,
      provider: this.getProviderName(),
      status: this.status,
      phoneNumber: this.phoneNumber,
      isHealthy: this.isHealthy(),
      healthMetrics: this.getHealthMetrics(),
      lastError: this.lastError?.message || null
    };
  }
}

export default BaseProvider;
