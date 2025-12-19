import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { getQueuedMessages, getQueueLength, enqueue, saveQueueSync } from './queue.js';

// ═══════════════════════════════════════════
// GLOBAL ERROR HANDLERS - Prevent crashes
// ═══════════════════════════════════════════

let isShuttingDown = false;

process.on('uncaughtException', (error) => {
  console.error('═══════════════════════════════════════════');
  console.error('💥 UNCAUGHT EXCEPTION');
  console.error('Time:', new Date().toISOString());
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
  console.error('═══════════════════════════════════════════');

  // Log but don't crash for non-fatal errors
  if (error.message?.includes('ECONNRESET') ||
      error.message?.includes('EPIPE') ||
      error.message?.includes('ETIMEDOUT')) {
    console.log('⚠️ Non-fatal error, continuing...');
    return;
  }

  // For fatal errors, graceful shutdown
  if (!isShuttingDown) {
    gracefulShutdown('uncaughtException');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('═══════════════════════════════════════════');
  console.error('💥 UNHANDLED REJECTION');
  console.error('Time:', new Date().toISOString());
  console.error('Reason:', reason);
  console.error('═══════════════════════════════════════════');
  // Don't crash, just log
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ═══════════════════════════════════════════
// FEATURE FLAG - HYBRID PROVIDERS
// ═══════════════════════════════════════════

const USE_HYBRID_PROVIDERS = process.env.USE_HYBRID_PROVIDERS === 'true';

// Conditionally import the appropriate session manager
let sessionManager;
let createCloudApiWebhookRoutes;

if (USE_HYBRID_PROVIDERS) {
  console.log('🔀 Mode: HYBRID PROVIDERS (Cloud API + Baileys fallback)');
  sessionManager = await import('./hybrid-session-manager.js');
  const webhookRoutes = await import('./routes/cloud-api-webhook.js');
  createCloudApiWebhookRoutes = webhookRoutes.createCloudApiWebhookRoutes;
} else {
  console.log('📱 Mode: BAILEYS ONLY (legacy)');
  sessionManager = await import('./session-manager.js');
}

const {
  createSession,
  getSession,
  getAllSessions,
  disconnectSession,
  sendMessage,
  onStatusChange,
  processQueue
} = sessionManager;

// Additional hybrid functions
const sendTemplateMessage = sessionManager.sendTemplateMessage;
const reconnectExistingSessions = sessionManager.reconnectExistingSessions;
const cleanupDeadSessions = sessionManager.cleanupDeadSessions;

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ═══════════════════════════════════════════
// CLOUD API WEBHOOK ROUTES (if hybrid mode)
// ═══════════════════════════════════════════

if (USE_HYBRID_PROVIDERS && createCloudApiWebhookRoutes) {
  app.use(createCloudApiWebhookRoutes(sessionManager));
  console.log('☁️  Cloud API webhook routes enabled');
}

// ═══════════════════════════════════════════
// ENDPOINTS REST
// ═══════════════════════════════════════════

app.get('/health', (req, res) => {
  const sessions = getAllSessions();
  const memUsage = process.memoryUsage();

  // Count sessions by status
  const sessionsByStatus = sessions.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});

  // Determine overall health
  const connectedCount = sessionsByStatus.connected || 0;
  const failedCount = sessionsByStatus.failed || 0;
  const totalSessions = sessions.length;

  let healthStatus = 'ok';
  if (isShuttingDown) {
    healthStatus = 'shutting_down';
  } else if (failedCount > 0 && connectedCount === 0 && totalSessions > 0) {
    healthStatus = 'degraded';
  } else if (memUsage.heapUsed > 400 * 1024 * 1024) { // > 400MB
    healthStatus = 'warning';
  }

  res.json({
    status: healthStatus,
    mode: USE_HYBRID_PROVIDERS ? 'hybrid' : 'baileys_only',
    uptime: Math.floor(process.uptime()),
    sessions: sessions,
    sessionCount: sessions.length,
    sessionsByStatus,
    queueLength: getQueueLength(),
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      rss: Math.round(memUsage.rss / 1024 / 1024),
      unit: 'MB'
    },
    websockets: {
      connections: wss?.clients?.size || 0
    }
  });
});

app.get('/sessions', (req, res) => {
  res.json(getAllSessions());
});

app.get('/session/:salonId', (req, res) => {
  const { salonId } = req.params;
  const session = getSession(salonId);

  if (!session) {
    return res.json({
      salonId,
      status: 'not_found'
    });
  }

  const response = {
    salonId,
    status: session.status,
    phoneNumber: session.phoneNumber,
    connectedAt: session.connectedAt,
    qrCode: session.qrCodeBase64
  };

  // Add provider info if hybrid mode
  if (USE_HYBRID_PROVIDERS && session.activeProvider) {
    response.activeProvider = session.activeProvider;
    response.providerStatuses = session.providerStatuses;
  }

  res.json(response);
});

app.post('/session/:salonId/connect', async (req, res) => {
  const { salonId } = req.params;
  console.log(`🔌 Connection request: ${salonId}`);

  try {
    const session = await createSession(salonId);

    const response = {
      salonId,
      status: session.status,
      phoneNumber: session.phoneNumber,
      qrCode: session.qrCodeBase64
    };

    if (USE_HYBRID_PROVIDERS && session.activeProvider) {
      response.activeProvider = session.activeProvider;
    }

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/session/:salonId', async (req, res) => {
  const { salonId } = req.params;
  const success = await disconnectSession(salonId);
  res.json({ salonId, success });
});

app.post('/session/:salonId/send', async (req, res) => {
  const { salonId } = req.params;
  const { phone, message, isLid, lidId } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: 'phone et message requis' });
  }

  try {
    const result = await sendMessage(salonId, phone, message, { isLid, lidId });
    res.json({
      success: true,
      messageId: result?.messageId,
      provider: result?.provider
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════
// TEMPLATE ENDPOINT (Hybrid mode only)
// ═══════════════════════════════════════════

app.post('/session/:salonId/send-template', async (req, res) => {
  if (!USE_HYBRID_PROVIDERS) {
    return res.status(400).json({
      error: 'Template messages require hybrid mode (USE_HYBRID_PROVIDERS=true)'
    });
  }

  const { salonId } = req.params;
  const { phone, templateName, params, language } = req.body;

  if (!phone || !templateName) {
    return res.status(400).json({ error: 'phone et templateName requis' });
  }

  try {
    const result = await sendTemplateMessage(salonId, phone, templateName, params || [], language || 'fr');
    res.json({
      success: true,
      messageId: result?.messageId,
      provider: result?.provider,
      templateName
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════
// ENDPOINTS DEBUG QUEUE
// ═══════════════════════════════════════════

app.get('/debug/queue', (req, res) => {
  res.json({
    length: getQueueLength(),
    messages: getQueuedMessages()
  });
});

app.post('/debug/queue/process', async (req, res) => {
  await processQueue();
  res.json({ success: true, remaining: getQueueLength() });
});

app.post('/debug/queue/add-test', (req, res) => {
  const testMessage = {
    from: '237000000000',
    messageId: `test-${Date.now()}`,
    timestamp: Math.floor(Date.now() / 1000),
    type: 'text',
    content: 'Message test queue',
    pushName: 'Test User',
    salonId: req.body.salonId || 'test-salon'
  };
  enqueue(testMessage);
  res.json({ success: true, queueLength: getQueueLength() });
});

app.delete('/debug/queue', (req, res) => {
  fs.writeFileSync('./message_queue.json', '[]');
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// PROVIDER INFO (Hybrid mode only)
// ═══════════════════════════════════════════

app.get('/providers', (req, res) => {
  if (!USE_HYBRID_PROVIDERS) {
    return res.json({
      mode: 'baileys_only',
      providers: ['baileys'],
      activeProvider: 'baileys'
    });
  }

  const { ProviderFactory } = require('./providers/provider-factory.js');

  res.json({
    mode: 'hybrid',
    supported: ProviderFactory.getSupportedProviders(),
    available: ProviderFactory.getAvailableProviders(),
    priority: ProviderFactory.getProviderPriority(),
    capabilities: {
      cloud_api: ProviderFactory.getCapabilities('cloud_api'),
      baileys: ProviderFactory.getCapabilities('baileys')
    }
  });
});

// ═══════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// WebSocket ping/pong interval for detecting dead connections
const WS_PING_INTERVAL = 30000; // 30 seconds
const WS_PONG_TIMEOUT = 10000;  // 10 seconds to respond

wss.on('connection', (ws) => {
  console.log('🔗 WebSocket connected');
  let unsubscribe = null;
  ws.isAlive = true;

  // Setup ping/pong heartbeat
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', async (data) => {
    // Message timeout protection
    const messageTimeout = setTimeout(() => {
      console.warn('⚠️ WebSocket message processing timeout');
    }, 30000);

    try {
      const msg = JSON.parse(data.toString());

      if (msg.action === 'subscribe' && msg.salonId) {
        if (unsubscribe) unsubscribe();

        unsubscribe = onStatusChange(msg.salonId, (statusData) => {
          // Check if ws is still open before sending
          if (ws.readyState === ws.OPEN) {
            try {
              ws.send(JSON.stringify({ type: 'status_update', salonId: msg.salonId, ...statusData }));
            } catch (sendError) {
              console.error('WebSocket send error:', sendError.message);
            }
          }
        });

        const session = getSession(msg.salonId);
        const response = {
          type: 'current_status',
          salonId: msg.salonId,
          status: session?.status || 'not_initialized',
          phoneNumber: session?.phoneNumber,
          qrCode: session?.qrCodeBase64
        };

        if (USE_HYBRID_PROVIDERS && session?.activeProvider) {
          response.activeProvider = session.activeProvider;
        }

        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(response));
        }
      }

      if (msg.action === 'connect' && msg.salonId) {
        await createSession(msg.salonId);
      }

      if (msg.action === 'disconnect' && msg.salonId) {
        await disconnectSession(msg.salonId);
      }

      // Respond to ping with pong
      if (msg.action === 'ping') {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      }
    } catch (e) {
      console.error('WebSocket error:', e.message);
    } finally {
      clearTimeout(messageTimeout);
    }
  });

  ws.on('close', () => {
    if (unsubscribe) unsubscribe();
    console.log('🔌 WebSocket disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket client error:', error.message);
    if (unsubscribe) unsubscribe();
  });
});

// Ping all clients periodically to detect dead connections
const wsPingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('🔌 Terminating dead WebSocket connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL);

// ═══════════════════════════════════════════
// AUTO-RECONNEXION
// ═══════════════════════════════════════════

async function autoReconnect() {
  // Use hybrid reconnect if available
  if (USE_HYBRID_PROVIDERS && reconnectExistingSessions) {
    await reconnectExistingSessions();
    return;
  }

  // Legacy reconnect
  const authDir = './auth';
  if (!fs.existsSync(authDir)) return;

  const dirs = fs.readdirSync(authDir).filter(d =>
    fs.statSync(path.join(authDir, d)).isDirectory()
  );

  if (dirs.length === 0) return;

  console.log(`\n🔄 Auto-reconnecting ${dirs.length} session(s)...\n`);

  for (const salonId of dirs) {
    console.log(`   ↳ ${salonId}`);
    await createSession(salonId);
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n✅ Auto-reconnect complete\n');
}

// ═══════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('🚀 WhatsApp Baileys Multi-Sessions Server');
  console.log(`📡 API: http://localhost:${PORT}`);
  console.log(`🔌 WS: ws://localhost:${PORT}/ws`);
  console.log(`📝 Webhook: ${process.env.WEBHOOK_URL || 'NOT CONFIGURED'}`);
  console.log(`📦 Queue: ${getQueueLength()} messages`);
  console.log('───────────────────────────────────────────────────────');
  console.log(`🔀 Mode: ${USE_HYBRID_PROVIDERS ? 'HYBRID (Cloud API + Baileys)' : 'BAILEYS ONLY'}`);

  if (USE_HYBRID_PROVIDERS) {
    console.log(`☁️  Primary: ${process.env.PRIMARY_PROVIDER || 'cloud_api'}`);
    console.log(`📞 Cloud API Phone ID: ${process.env.CLOUD_API_PHONE_NUMBER_ID || 'NOT SET'}`);
    console.log(`🔄 Fallback: ${process.env.FALLBACK_ENABLED !== 'false' ? 'ENABLED' : 'DISABLED'}`);
  }

  console.log('═══════════════════════════════════════════════════════\n');

  await autoReconnect();

  // Start periodic cleanup of dead sessions (every 10 minutes)
  if (cleanupDeadSessions) {
    setInterval(() => {
      try {
        cleanupDeadSessions();
      } catch (e) {
        console.error('Session cleanup error:', e.message);
      }
    }, 10 * 60 * 1000);
    console.log('🧹 Periodic session cleanup enabled (every 10 min)');
  }
});

// ═══════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log('⚠️ Shutdown already in progress...');
    return;
  }

  isShuttingDown = true;
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`🛑 Graceful shutdown initiated (${signal})`);
  console.log(`═══════════════════════════════════════════`);

  const shutdownTimeout = setTimeout(() => {
    console.error('⚠️ Shutdown timeout - forcing exit');
    process.exit(1);
  }, 30000); // 30s max for shutdown

  try {
    // 1. Stop accepting new connections
    console.log('📡 Closing HTTP server...');
    server.close();

    // 2. Stop WebSocket ping interval
    console.log('🔌 Stopping WebSocket ping interval...');
    clearInterval(wsPingInterval);

    // 3. Close all WebSocket connections
    console.log('🔌 Closing WebSocket connections...');
    wss.clients.forEach((ws) => {
      ws.close(1001, 'Server shutting down');
    });

    // 4. Save queue state
    console.log('📦 Saving queue state...');
    saveQueueSync();

    // 5. Disconnect all sessions gracefully
    console.log('📱 Disconnecting sessions...');
    const sessions = getAllSessions();
    for (const session of sessions) {
      try {
        await disconnectSession(session.salonId);
        console.log(`   ✓ ${session.salonId} disconnected`);
      } catch (e) {
        console.error(`   ✗ ${session.salonId} error:`, e.message);
      }
    }

    console.log('✅ Graceful shutdown complete');
    clearTimeout(shutdownTimeout);
    process.exit(0);

  } catch (error) {
    console.error('❌ Shutdown error:', error);
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}
