import fs from 'fs';

const QUEUE_FILE = './message_queue.json';
let messageQueue = [];

// Charger la queue depuis le disque au démarrage
export function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const data = fs.readFileSync(QUEUE_FILE, 'utf-8');
      messageQueue = JSON.parse(data);
      console.log(`📦 ${messageQueue.length} messages en attente chargés`);
    }
  } catch (error) {
    console.error('Erreur chargement queue:', error.message);
    messageQueue = [];
  }
}

// Sauvegarder la queue sur disque
function saveQueue() {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(messageQueue, null, 2));
  } catch (error) {
    console.error('Erreur sauvegarde queue:', error.message);
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

// Supprimer les messages avec trop de tentatives (max 5)
export function cleanupFailedMessages() {
  const before = messageQueue.length;
  messageQueue = messageQueue.filter(m => m.attempts < 5);
  const removed = before - messageQueue.length;
  if (removed > 0) {
    console.log(`🗑️ ${removed} messages abandonnés après 5 échecs`);
    saveQueue();
  }
}

export function getQueueLength() {
  return messageQueue.length;
}

// Charger la queue au démarrage du module
loadQueue();
