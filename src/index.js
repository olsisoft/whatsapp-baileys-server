import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { 
  createSession, 
  getSession, 
  getAllSessions, 
  disconnectSession,
  sendMessage,
  onStatusChange,
  processQueue
} from './session-manager.js';
import { getQueuedMessages, getQueueLength, enqueue } from './queue.js';

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
// ENDPOINTS REST
// ═══════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    sessions: getAllSessions(),
    queueLength: getQueueLength()
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

  res.json({
    salonId,
    status: session.status,
    phoneNumber: session.phoneNumber,
    connectedAt: session.connectedAt,
    qrCode: session.qrCodeBase64
  });
});

app.post('/session/:salonId/connect', async (req, res) => {
  const { salonId } = req.params;
  console.log(`🔌 Demande de connexion: ${salonId}`);
  
  const session = await createSession(salonId);
  
  res.json({
    salonId,
    status: session.status,
    phoneNumber: session.phoneNumber,
    qrCode: session.qrCodeBase64
  });
});

app.delete('/session/:salonId', async (req, res) => {
  const { salonId } = req.params;
  const success = await disconnectSession(salonId);
  res.json({ salonId, success });
});

app.post('/session/:salonId/send', async (req, res) => {
  const { salonId } = req.params;
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: 'phone et message requis' });
  }

  try {
    await sendMessage(salonId, phone, message);
    res.json({ success: true });
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
// WEBSOCKET
// ═══════════════════════════════════════════

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('🔗 WebSocket connecté');
  let unsubscribe = null;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.action === 'subscribe' && msg.salonId) {
        if (unsubscribe) unsubscribe();
        
        unsubscribe = onStatusChange(msg.salonId, (statusData) => {
          ws.send(JSON.stringify({ type: 'status_update', salonId: msg.salonId, ...statusData }));
        });

        const session = getSession(msg.salonId);
        ws.send(JSON.stringify({
          type: 'current_status',
          salonId: msg.salonId,
          status: session?.status || 'not_initialized',
          phoneNumber: session?.phoneNumber,
          qrCode: session?.qrCodeBase64
        }));
      }

      if (msg.action === 'connect' && msg.salonId) {
        await createSession(msg.salonId);
      }

      if (msg.action === 'disconnect' && msg.salonId) {
        await disconnectSession(msg.salonId);
      }
    } catch (e) {
      console.error('Erreur WebSocket:', e);
    }
  });

  ws.on('close', () => {
    if (unsubscribe) unsubscribe();
    console.log('🔌 WebSocket déconnecté');
  });
});

// ═══════════════════════════════════════════
// AUTO-RECONNEXION
// ═══════════════════════════════════════════

async function autoReconnect() {
  const authDir = './auth';
  if (!fs.existsSync(authDir)) return;

  const dirs = fs.readdirSync(authDir).filter(d => 
    fs.statSync(path.join(authDir, d)).isDirectory()
  );

  if (dirs.length === 0) return;

  console.log(`\n🔄 Auto-reconnexion de ${dirs.length} session(s)...\n`);

  for (const salonId of dirs) {
    console.log(`   ↳ ${salonId}`);
    await createSession(salonId);
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n✅ Auto-reconnexion terminée\n');
}

// ═══════════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════════

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('🚀 Serveur Baileys Multi-Sessions');
  console.log(`📡 API: http://localhost:${PORT}`);
  console.log(`🔌 WS: ws://localhost:${PORT}/ws`);
  console.log(`📝 Webhook: ${process.env.WEBHOOK_URL}`);
  console.log(`📦 Queue: ${getQueueLength()} messages`);
  console.log('═══════════════════════════════════════════════════════\n');

  await autoReconnect();
});
