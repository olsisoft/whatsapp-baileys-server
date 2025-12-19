/**
 * Cloud API Webhook Routes
 * Handles incoming webhooks from Meta WhatsApp Business Platform
 */

import express from 'express';

const router = express.Router();

/**
 * Create webhook routes with session manager dependency
 * @param {object} sessionManager - Hybrid session manager instance
 * @returns {Router}
 */
export function createCloudApiWebhookRoutes(sessionManager) {
  /**
   * GET /webhook/cloud-api
   * Webhook verification endpoint (required by Meta)
   */
  router.get('/webhook/cloud-api', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    try {
      const result = sessionManager.verifyCloudApiWebhook(mode, token, challenge);
      console.log('Cloud API webhook verified successfully');
      res.status(200).send(result);
    } catch (error) {
      console.error('Cloud API webhook verification failed:', error.message);
      res.sendStatus(403);
    }
  });

  /**
   * POST /webhook/cloud-api
   * Receive incoming messages and status updates from Meta
   */
  router.post('/webhook/cloud-api', async (req, res) => {
    // Always respond 200 quickly (Meta requirement)
    res.sendStatus(200);

    try {
      const body = req.body;

      // Validate it's a WhatsApp Business Account webhook
      if (body.object !== 'whatsapp_business_account') {
        console.log('Ignoring non-WhatsApp webhook');
        return;
      }

      // Process the webhook
      const results = sessionManager.handleCloudApiWebhook(body);

      if (results && results.length > 0) {
        console.log(`Processed ${results.length} incoming message(s) from Cloud API`);
      }

    } catch (error) {
      console.error('Error processing Cloud API webhook:', error);
      // Don't throw - we already sent 200 response
    }
  });

  return router;
}

/**
 * Standalone webhook routes (for use without session manager injection)
 */
export const standaloneWebhookRoutes = express.Router();

standaloneWebhookRoutes.get('/webhook/cloud-api', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.CLOUD_API_VERIFY_TOKEN || 'whatsapp_webhook_verify';

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('Cloud API webhook verified');
    res.status(200).send(challenge);
  } else {
    console.error('Cloud API webhook verification failed');
    res.sendStatus(403);
  }
});

standaloneWebhookRoutes.post('/webhook/cloud-api', (req, res) => {
  res.sendStatus(200);
  console.log('Received Cloud API webhook (standalone mode - not processed)');
  console.log('To process webhooks, enable USE_HYBRID_PROVIDERS=true');
});

export default { createCloudApiWebhookRoutes, standaloneWebhookRoutes };
