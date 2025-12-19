/**
 * Provider Factory - Creates provider instances based on configuration
 */

import { CloudApiProvider } from './cloud-api-provider.js';
import { BaileysProvider } from './baileys-provider.js';

export class ProviderFactory {
  /**
   * Create a provider instance
   * @param {string} providerType - 'cloud_api' or 'baileys'
   * @param {string} salonId - Salon identifier
   * @param {object} config - Provider configuration
   * @param {object} options - Additional options (callbacks, etc.)
   * @returns {BaseProvider} Provider instance
   */
  static create(providerType, salonId, config = {}, options = {}) {
    switch (providerType) {
      case 'cloud_api':
        return new CloudApiProvider(salonId, config, options);

      case 'baileys':
        return new BaileysProvider(salonId, config, options);

      default:
        throw new Error(`Unknown provider type: ${providerType}`);
    }
  }

  /**
   * Check if a provider type is available based on configuration
   * @param {string} providerType - Provider type to check
   * @param {object} config - Configuration object
   * @returns {boolean}
   */
  static isAvailable(providerType, config = {}) {
    switch (providerType) {
      case 'cloud_api':
        // Cloud API requires credentials
        const hasCloudApiCreds =
          (config.phoneNumberId || process.env.CLOUD_API_PHONE_NUMBER_ID) &&
          (config.accessToken || process.env.CLOUD_API_ACCESS_TOKEN);
        const cloudApiEnabled = config.cloudApiEnabled !== false &&
          process.env.CLOUD_API_ENABLED !== 'false';
        return hasCloudApiCreds && cloudApiEnabled;

      case 'baileys':
        // Baileys is always available unless explicitly disabled
        const baileysEnabled = config.baileysEnabled !== false &&
          process.env.BAILEYS_ENABLED !== 'false';
        return baileysEnabled;

      default:
        return false;
    }
  }

  /**
   * Get list of supported provider types
   * @returns {string[]}
   */
  static getSupportedProviders() {
    return ['cloud_api', 'baileys'];
  }

  /**
   * Get list of available providers based on configuration
   * @param {object} config - Configuration object
   * @returns {string[]}
   */
  static getAvailableProviders(config = {}) {
    return this.getSupportedProviders().filter(
      provider => this.isAvailable(provider, config)
    );
  }

  /**
   * Get provider priority order from configuration
   * @param {object} config - Configuration object
   * @returns {string[]}
   */
  static getProviderPriority(config = {}) {
    // Check config first
    if (config.providerPriority && Array.isArray(config.providerPriority)) {
      return config.providerPriority.filter(p => this.isAvailable(p, config));
    }

    // Check environment variable
    const envPrimary = process.env.PRIMARY_PROVIDER;
    if (envPrimary) {
      const priority = [envPrimary];

      // Add fallback if not already primary
      const fallback = envPrimary === 'cloud_api' ? 'baileys' : 'cloud_api';
      if (this.isAvailable(fallback, config)) {
        priority.push(fallback);
      }

      return priority.filter(p => this.isAvailable(p, config));
    }

    // Default: Cloud API primary, Baileys fallback
    const defaultPriority = ['cloud_api', 'baileys'];
    return defaultPriority.filter(p => this.isAvailable(p, config));
  }

  /**
   * Get provider capabilities
   * @param {string} providerType - Provider type
   * @returns {object}
   */
  static getCapabilities(providerType) {
    switch (providerType) {
      case 'cloud_api':
        return {
          supportsTemplates: true,
          supportsButtons: true,
          supportsLists: true,
          supportsMedia: true,
          supportsLocation: true,
          supportsContacts: true,
          supportsReactions: true,
          requiresQrCode: false,
          isOfficial: true
        };

      case 'baileys':
        return {
          supportsTemplates: false,
          supportsButtons: false,
          supportsLists: false,
          supportsMedia: true,
          supportsLocation: true,
          supportsContacts: true,
          supportsReactions: true,
          requiresQrCode: true,
          isOfficial: false
        };

      default:
        return {};
    }
  }
}

export default ProviderFactory;
