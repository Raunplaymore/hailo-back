// Swing video upload server for Raspberry Pi
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const {
  buildFrameSequenceFromFile,
  swingAnalysis,
  ballFlightAnalysis,
  shotTypeClassifier,
  coachSummaryGenerator,
} = require('./analysis/engine');
const shotStore = require('./store/shotStore');

const app = express();
const PORT = 3000;
// Default to local uploads directory; allow override for Raspberry Pi via env
const uploadDir =
  process.env.UPLOAD_DIR ||
  (fs.existsSync('/home/ray/uploads') ? '/home/ray/uploads' : path.join(__dirname, 'uploads'));

// Ensure upload directory exists
fs.mkdirSync(uploadDir, { recursive: true });

// Configure multer storage: timestamp prefix keeps uploads unique
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) =>
    cb(null, `${Date.now()}-${randomUUID()}-${file.originalname}`),
});

const upload = multer({ storage });
app.use(express.json());

// Simple CORS (allow configurable origin, default all)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

function toNumberOrUndefined(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function buildAnalysisFromFrames(frameSeq) {
  const swing = swingAnalysis(frameSeq);
  const ballFlight = ballFlightAnalysis(frameSeq);
  const shotType = shotTypeClassifier({ swing, ballFlight });
  const coachSummary = coachSummaryGenerator({ swing, ballFlight, shotType });
  return { swing, ballFlight, shot_type: shotType, coach_summary: coachSummary };
}

// Analyze uploaded video and store shot result
app.post('/analyze/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, message: 'No file uploaded' });
  }

  const meta = {
    club: req.body.club,
    fps: toNumberOrUndefined(req.body.fps),
    cameraConfig: req.body.cameraConfig,
    sourceType: 'upload',
  };

  const frameSeq = buildFrameSequenceFromFile(req.file.path, meta);
  const analysis = buildAnalysisFromFrames(frameSeq);

  const sessionId = shotStore.ensureSessionPersisted(
    req.body.sessionId,
    req.body.sessionName || 'default',
    { sourceType: 'upload' },
  );

  const shot = {
    id: randomUUID(),
    sessionId,
    sourceType: 'upload',
    createdAt: new Date().toISOString(),
    media: {
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size,
    },
    metadata: meta,
    analysis,
  };

  shotStore.addShot(shot);
  res.json({ ok: true, shot });
});

// Register a shot from camera pipeline (metadata only placeholder)
app.post('/shots', (req, res) => {
  const payload = req.body || {};
  const sessionId = shotStore.ensureSessionPersisted(
    payload.sessionId,
    payload.sessionName || 'camera-session',
    { sourceType: payload.sourceType || 'camera' },
  );

  const frameSeq = {
    id: randomUUID(),
    sourceType: payload.sourceType || 'camera',
    fps: toNumberOrUndefined(payload.fps),
    camera: payload.cameraConfig || {},
    frames: [],
  };

  const analysis = buildAnalysisFromFrames(frameSeq);

  const shot = {
    id: randomUUID(),
    sessionId,
    sourceType: payload.sourceType || 'camera',
    createdAt: new Date().toISOString(),
    media: payload.media || {},
    metadata: {
      club: payload.club,
      fps: frameSeq.fps,
      cameraConfig: payload.cameraConfig,
    },
    analysis,
  };

  shotStore.addShot(shot);
  res.json({ ok: true, shot });
});

app.get('/sessions', (_req, res) => {
  const sessions = shotStore.listSessions();
  res.json({ ok: true, sessions });
});

app.get('/sessions/:id', (req, res) => {
  const session = shotStore.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ ok: false, message: 'Session not found' });
  }
  const shots = shotStore.listShotsBySession(req.params.id);
  res.json({ ok: true, session, shots });
});

app.get('/shots/:id/analysis', (req, res) => {
  const shot = shotStore.getShot(req.params.id);
  if (!shot) {
    return res.status(404).json({ ok: false, message: 'Shot not found' });
  }
  res.json({ ok: true, analysis: shot.analysis });
});

// Upload endpoint: expects multipart/form-data with field "video"
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, message: 'No file uploaded' });
  }
  res.json({ ok: true, file: req.file.filename });
});

// List uploaded files
app.get('/api/files', (_req, res) => {
  fs.readdir(uploadDir, (err, files) => {
    if (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
    res.json(files);
  });
});

// Delete a file by name
app.delete('/api/files/:name', async (req, res) => {
  const resolvedUpload = path.resolve(uploadDir);
  const target = path.resolve(uploadDir, req.params.name);

  // Prevent path traversal outside uploadDir
  if (!target.startsWith(`${resolvedUpload}${path.sep}`)) {
    return res.status(400).json({ ok: false, message: 'Invalid file path' });
  }

  try {
    await fs.promises.unlink(target);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ ok: false, message: 'File not found' });
    }
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Serve uploaded files statically; fallthrough false to avoid SPA fallback on 404
app.use('/uploads', express.static(uploadDir, { fallthrough: false }));

// Serve built React app
app.use(express.static(path.join(__dirname, 'client-dist')));

// SPA fallback for all other GET routes (regex avoids Express 5 wildcard parsing issues)
app.get(/.*/, (_req, res) => {
  const indexPath = path.join(__dirname, 'client-dist', 'index.html');
  fs.access(indexPath, fs.constants.F_OK, (err) => {
    if (err) {
      return res.status(404).send('index.html not found');
    }
    res.sendFile(indexPath);
  });
});

// Global error handler to ensure JSON error responses
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, message: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Swing server listening on port ${PORT}`);
});
