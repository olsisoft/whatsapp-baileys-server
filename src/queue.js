import fs from 'fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const QUEUE_FILE = './message_queue.json';
const MESSAGE_TTL = 24 * 60 * 60 * 1000; // 24 hours TTL for messages
let messageQueue = [];
let saveInProgress = false;
let pendingSave = false;

// Charger la queue depuis le disque au démarrage (sync for initialization)
export function loadQueue() {
  try {
    if (existsSync(QUEUE_FILE)) {
      const data = readFileSync(QUEUE_FILE, 'utf-8');
      messageQueue = JSON.parse(data);
      // Clean up old messages on load
      const now = Date.now();
      const before = messageQueue.length;
      messageQueue = messageQueue.filter(m => (now - m.queuedAt) < MESSAGE_TTL);
      const removed = before - messageQueue.length;
      if (removed > 0) {
        console.log(`🧹 Removed ${removed} expired messages from queue`);
      }
      console.log(`📦 ${messageQueue.length} messages en attente chargés`);
    }
  } catch (error) {
    console.error('Erreur chargement queue:', error.message);
    messageQueue = [];
  }
}

// Sauvegarder la queue sur disque (async, debounced)
async function saveQueue() {
  // If save is in progress, mark as pending
  if (saveInProgress) {
    pendingSave = true;
    return;
  }

  saveInProgress = true;

  try {
    await fs.writeFile(QUEUE_FILE, JSON.stringify(messageQueue, null, 2));
  } catch (error) {
    console.error('Erreur sauvegarde queue:', error.message);
  } finally {
    saveInProgress = false;

    // If there was a pending save, do it now
    if (pendingSave) {
      pendingSave = false;
      setImmediate(() => saveQueue());
    }
  }
}

// Sync save for critical operations (shutdown)
export function saveQueueSync() {
  try {
    writeFileSync(QUEUE_FILE, JSON.stringify(messageQueue, null, 2));
  } catch (error) {
    console.error('Erreur sauvegarde queue sync:', error.message);
  }
}

// Ajouter un message à la queue
export function enqueue(messageData) {
  messageQueue.push({
    ...messageData,
    queuedAt: Date.now(),
    attempts: 0
  });
  saveQueue();
  console.log(`📦 Message ajouté à la queue (${messageQueue.length} en attente)`);
}

// Récupérer tous les messages en attente
export function getQueuedMessages() {
  return [...messageQueue];
}

// Supprimer un message de la queue (après succès)
export function dequeue(messageId) {
  messageQueue = messageQueue.filter(m => m.messageId !== messageId);
  saveQueue();
}

// Incrémenter les tentatives
export function incrementAttempts(messageId) {
  const msg = messageQueue.find(m => m.messageId === messageId);
  if (msg) {
    msg.attempts++;
    saveQueue();
  }
}

// Supprimer les messages avec trop de tentatives (max 5) ou expirés
export function cleanupFailedMessages() {
  const before = messageQueue.length;
  const now = Date.now();

  messageQueue = messageQueue.filter(m => {
    // Remove if too many attempts
    if (m.attempts >= 5) return false;
    // Remove if expired (TTL)
    if ((now - m.queuedAt) >= MESSAGE_TTL) return false;
    return true;
  });

  const removed = before - messageQueue.length;
  if (removed > 0) {
    console.log(`🗑️ ${removed} messages supprimés (échecs ou expirés)`);
    saveQueue();
  }
}

// Get next retry delay with exponential backoff
export function getRetryDelay(attempts) {
  const baseDelay = 1000; // 1 second
  const maxDelay = 30000; // 30 seconds max
  return Math.min(baseDelay * Math.pow(2, attempts), maxDelay);
}

export function getQueueLength() {
  return messageQueue.length;
}

// Charger la queue au démarrage du module
loadQueue();
