const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const dataDir = path.join(__dirname, '..', 'data');
const storePath = path.join(dataDir, 'shots.json');

fs.mkdirSync(dataDir, { recursive: true });

function loadStore() {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { sessions: [], shots: [] };
  }
}

function saveStore(store) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
}

function ensureSession(store, sessionId, name, meta = {}) {
  if (sessionId) {
    const existing = store.sessions.find((s) => s.id === sessionId);
    if (existing) return sessionId;
  }
  const id = randomUUID();
  store.sessions.push({
    id,
    name: name || 'default',
    metadata: meta,
    createdAt: new Date().toISOString(),
  });
  return id;
}

function ensureSessionPersisted(sessionId, name, meta = {}) {
  const store = loadStore();
  const id = ensureSession(store, sessionId, name, meta);
  saveStore(store);
  return id;
}

function addShot(shot) {
  const store = loadStore();
  store.shots.push(shot);
  saveStore(store);
  return shot.id;
}

function listSessions() {
  const store = loadStore();
  return store.sessions;
}

function listShots() {
  const store = loadStore();
  return store.shots;
}

function getSession(id) {
  const store = loadStore();
  return store.sessions.find((s) => s.id === id);
}

function listShotsBySession(sessionId) {
  const store = loadStore();
  return store.shots.filter((s) => s.sessionId === sessionId);
}

function getShot(id) {
  const store = loadStore();
  return store.shots.find((s) => s.id === id);
}

function getShotByMediaName(name) {
  const store = loadStore();
  return store.shots.find((s) => s.media?.filename === name);
}

module.exports = {
  loadStore,
  saveStore,
  ensureSession,
  ensureSessionPersisted,
  addShot,
  listShots,
  listSessions,
  getSession,
  listShotsBySession,
  getShot,
  getShotByMediaName,
};
