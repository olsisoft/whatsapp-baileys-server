/**
 * Provider Configuration - Schema and utilities for provider configuration
 */

/**
 * Load configuration from environment variables
 * @returns {object} Configuration object
 */
export function loadConfig() {
  return {
    // Feature flag
    useHybridProviders: process.env.USE_HYBRID_PROVIDERS === 'true',

    // Primary provider
    primaryProvider: process.env.PRIMARY_PROVIDER || 'baileys',

    // Provider priority (derived from primary)
    providerPriority: getProviderPriorityFromEnv(),

    // Cloud API configuration
    cloudApi: {
      enabled: process.env.CLOUD_API_ENABLED !== 'false',
      phoneNumberId: process.env.CLOUD_API_PHONE_NUMBER_ID || null,
      accessToken: process.env.CLOUD_API_ACCESS_TOKEN || null,
      businessAccountId: process.env.CLOUD_API_BUSINESS_ACCOUNT_ID || null,
      verifyToken: process.env.CLOUD_API_VERIFY_TOKEN || 'whatsapp_webhook_verify'
    },

    // Baileys configuration
    baileys: {
      enabled: process.env.BAILEYS_ENABLED !== 'false'
    },

    // Fallback configuration
    fallback: {
      enabled: process.env.FALLBACK_ENABLED !== 'false',
      maxRetries: parseInt(process.env.FALLBACK_MAX_RETRIES) || 3,
      retryDelayMs: parseInt(process.env.FALLBACK_RETRY_DELAY_MS) || 1000,
      triggers: {
        onTimeout: true,
        onRateLimit: true,
        onTemplateError: true,
        onServerError: true
      }
    },

    // Polling configuration (for outgoing messages from Supabase)
    polling: {
      enabled: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
      interval: parseInt(process.env.POLLING_INTERVAL) || 5000
    },

    // Webhook configuration
    webhook: {
      url: process.env.WEBHOOK_URL || null,
      timeout: 15000
    },

    // Supabase configuration
    supabase: {
      url: process.env.SUPABASE_URL || null,
      anonKey: process.env.SUPABASE_ANON_KEY || null
    }
  };
}

/**
 * Get provider priority from environment
 * @returns {string[]}
 */
function getProviderPriorityFromEnv() {
  const primary = process.env.PRIMARY_PROVIDER || 'baileys';
  const priority = [primary];

  // Add fallback provider
  if (primary === 'cloud_api') {
    if (process.env.BAILEYS_ENABLED !== 'false') {
      priority.push('baileys');
    }
  } else {
    if (process.env.CLOUD_API_ENABLED !== 'false' && process.env.CLOUD_API_PHONE_NUMBER_ID) {
      priority.push('cloud_api');
    }
  }

  return priority;
}

/**
 * Validate configuration
 * @param {object} config - Configuration to validate
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  // Check provider priority
  if (!config.providerPriority || config.providerPriority.length === 0) {
    errors.push('No providers configured');
  }

  // Check Cloud API config if enabled
  if (config.cloudApi?.enabled) {
    if (!config.cloudApi.phoneNumberId) {
      warnings.push('Cloud API enabled but CLOUD_API_PHONE_NUMBER_ID not set');
    }
    if (!config.cloudApi.accessToken) {
      warnings.push('Cloud API enabled but CLOUD_API_ACCESS_TOKEN not set');
    }
  }

  // Check webhook
  if (!config.webhook?.url) {
    warnings.push('WEBHOOK_URL not configured - incoming messages will not be forwarded');
  }

  // Check Supabase
  if (!config.supabase?.url || !config.supabase?.anonKey) {
    warnings.push('Supabase not configured - outgoing message polling disabled');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Get fallback configuration
 * @param {object} config - Configuration object
 * @returns {object}
 */
export function getFallbackConfig(config) {
  return {
    enabled: config.fallback?.enabled ?? true,
    maxRetries: config.fallback?.maxRetries ?? 3,
    retryDelayMs: config.fallback?.retryDelayMs ?? 1000,
    triggers: config.fallback?.triggers ?? {
      onTimeout: true,
      onRateLimit: true,
      onTemplateError: true,
      onServerError: true
    }
  };
}

/**
 * Check if fallback should be triggered
 * @param {object} error - Error object
 * @param {object} fallbackConfig - Fallback configuration
 * @returns {boolean}
 */
export function shouldTriggerFallback(error, fallbackConfig) {
  if (!fallbackConfig.enabled) return false;

  const triggers = fallbackConfig.triggers;

  // Timeout
  if (triggers.onTimeout && (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET')) {
    return true;
  }

  // Rate limit
  if (triggers.onRateLimit && error.isRateLimit) {
    return true;
  }

  // Template error
  if (triggers.onTemplateError && error.isTemplateError) {
    return true;
  }

  // Server error (5xx)
  if (triggers.onServerError && error.code >= 500) {
    return true;
  }

  return false;
}

/**
 * Default configuration for Baileys-only mode
 */
export const defaultBaileysOnlyConfig = {
  useHybridProviders: false,
  primaryProvider: 'baileys',
  providerPriority: ['baileys'],
  cloudApi: { enabled: false },
  baileys: { enabled: true },
  fallback: { enabled: false }
};

/**
 * Default configuration for Cloud API with Baileys fallback
 */
export const defaultHybridConfig = {
  useHybridProviders: true,
  primaryProvider: 'cloud_api',
  providerPriority: ['cloud_api', 'baileys'],
  cloudApi: { enabled: true },
  baileys: { enabled: true },
  fallback: {
    enabled: true,
    maxRetries: 3,
    retryDelayMs: 1000
  }
};

export default {
  loadConfig,
  validateConfig,
  getFallbackConfig,
  shouldTriggerFallback,
  defaultBaileysOnlyConfig,
  defaultHybridConfig
};
