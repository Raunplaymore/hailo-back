// Swing video upload server for Raspberry Pi
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const {
  buildFrameSequenceFromFile,
  analyzeFrameSequence,
} = require('./analysis/engine');
const shotStore = require('./store/shotStore');

const app = express();
const PORT = 3000;
// Default to local uploads directory; allow override for Raspberry Pi via env
const uploadDir =
  process.env.UPLOAD_DIR ||
  (fs.existsSync('/home/ray/uploads') ? '/home/ray/uploads' : path.join(__dirname, 'uploads'));
const healthDir = path.join(__dirname, 'health');

// Ensure upload directory exists
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(healthDir, { recursive: true });

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
  return analyzeFrameSequence(frameSeq);
}

function swingPathDirection(clubPathAngle) {
  if (clubPathAngle === undefined || clubPathAngle === null) return 'unknown';
  const angle = Number(clubPathAngle);
  if (!Number.isFinite(angle)) return 'unknown';
  if (angle > 3) return 'out-to-in';
  if (angle < -3) return 'in-to-out';
  return 'in-to-in';
}

function formatAnalysisForFrontend(raw) {
  if (!raw) return null;
  const swing = raw.swing || {};
  const ball = raw.ballFlight || {};
  return {
    ...raw,
    swing_plane: {
      club_path_angle: swing.club_path_angle,
      downswing_path_curve: swing.downswing_path_curve,
      shaft_forward_lean_at_impact: swing.shaft_forward_lean_at_impact,
      shaft_angle_change_rate: swing.shaft_angle_change_rate,
      on_plane_ratio: swing.on_plane_ratio,
      plane_deviation_std: swing.plane_deviation_std,
      path_direction: swingPathDirection(swing.club_path_angle),
    },
    low_point: {
      low_point_position_relative_to_ball: ball.low_point_position_relative_to_ball,
      low_point_depth: ball.low_point_depth,
      attack_angle_category: ball.attack_angle_category,
    },
    tempo: {
      backswing_time_ms: swing.backswing_time_ms,
      downswing_time_ms: swing.downswing_time_ms,
      tempo_ratio: swing.tempo_ratio,
      acceleration_rate: swing.acceleration_rate,
      max_clubhead_speed_frame_index: swing.max_clubhead_speed_frame_index,
    },
    impact: {
      vertical_launch_angle: ball.vertical_launch_angle,
      horizontal_launch_direction: ball.horizontal_launch_direction,
      initial_velocity: ball.initial_velocity,
      spin_bias: ball.spin_bias,
      side_curve_intensity: ball.side_curve_intensity,
      apex_height_relative: ball.apex_height_relative,
      side_deviation: ball.side_deviation,
      projected_carry_distance: ball.projected_carry_distance,
    },
    body_motion: {
      head_movement: swing.head_movement,
      upper_body_tilt_change: swing.upper_body_tilt_change,
      shoulder_angle_at_address: swing.shoulder_angle_at_address,
      shoulder_angle_at_impact: swing.shoulder_angle_at_impact,
    },
  };
}

async function analyzeAndStoreUploadedShot(file, body) {
  const meta = {
    club: body.club,
    fps: toNumberOrUndefined(body.fps),
    cameraConfig: body.cameraConfig,
    roi: body.roi,
    sourceType: 'upload',
  };

  const frameSeq = buildFrameSequenceFromFile(file.path, meta);
  let analysis;
  analysis = await buildAnalysisFromFrames(frameSeq);
  analysis = formatAnalysisForFrontend(analysis);

  const sessionId = shotStore.ensureSessionPersisted(
    body.sessionId,
    body.sessionName || 'default',
    { sourceType: 'upload' },
  );

  const shot = {
    id: randomUUID(),
    sessionId,
    sourceType: 'upload',
    createdAt: new Date().toISOString(),
    media: {
      filename: file.filename,
      path: file.path,
      size: file.size,
    },
    metadata: meta,
    analysis,
  };

  shotStore.addShot(shot);
  return shot;
}

// Analyze uploaded video and store shot result
const analyzeUploadHandler = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, message: 'No file uploaded' });
  }

  try {
    const shot = await analyzeAndStoreUploadedShot(req.file, req.body);
    res.json({ ok: true, shot });
  } catch (err) {
    console.error('analyze/upload failed', err);
    res.status(500).json({ ok: false, message: 'Analysis failed' });
  }
};
app.post('/analyze/upload', upload.single('video'), analyzeUploadHandler);
app.post('/api/analyze/upload', upload.single('video'), analyzeUploadHandler);

// Register a shot from camera pipeline (metadata only placeholder)
const createShotHandler = async (req, res) => {
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

  let analysis;
  try {
    analysis = await buildAnalysisFromFrames(frameSeq);
    analysis = formatAnalysisForFrontend(analysis);
  } catch (err) {
    console.error('shots analysis failed', err);
    return res.status(500).json({ ok: false, message: 'Analysis failed' });
  }

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
};
app.post('/shots', createShotHandler);
app.post('/api/shots', createShotHandler);

const listShotsHandler = (_req, res) => {
  const shots = shotStore.listShots();
  res.json({ ok: true, shots });
};
app.get('/shots', listShotsHandler);
app.get('/api/shots', listShotsHandler);

const listSessionsHandler = (_req, res) => {
  const sessions = shotStore.listSessions();
  res.json({ ok: true, sessions });
};
app.get('/sessions', listSessionsHandler);
app.get('/api/sessions', listSessionsHandler);

const getSessionHandler = (req, res) => {
  const session = shotStore.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ ok: false, message: 'Session not found' });
  }
  const shots = shotStore.listShotsBySession(req.params.id);
  res.json({ ok: true, session, shots });
};
app.get('/sessions/:id', getSessionHandler);
app.get('/api/sessions/:id', getSessionHandler);

const getShotAnalysisHandler = (req, res) => {
  const shot =
    shotStore.getShot(req.params.id) ||
    shotStore.getShotByMediaName(req.params.id);
  if (!shot) {
    // Fallback: if file exists but shot not stored yet, return analysis null
    const candidatePath = path.resolve(uploadDir, req.params.id);
    if (fs.existsSync(candidatePath)) {
      return res.json({
        ok: true,
        id: req.params.id,
        analysis: null,
        message: 'Analysis not found; file exists',
      });
    }
    // Gracefully return empty analysis to avoid frontend errors
    return res.json({
      ok: true,
      id: req.params.id,
      analysis: null,
      message: 'Shot not found',
    });
  }
  res.json({ ok: true, id: shot.id, analysis: shot.analysis });
};
app.get('/shots/:id/analysis', getShotAnalysisHandler);
app.get('/api/shots/:id/analysis', getShotAnalysisHandler);

// Upload endpoint: expects multipart/form-data with field "video"
// If analyze=true (query or body), runs analysis and registers a shot.
app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, message: 'No file uploaded' });
  }
  const shouldAnalyze =
    req.query.analyze === 'true' || req.body?.analyze === 'true';
  if (!shouldAnalyze) {
    return res.json({ ok: true, file: req.file.filename });
  }
  try {
    const shot = await analyzeAndStoreUploadedShot(req.file, req.body || {});
    return res.json({ ok: true, file: req.file.filename, shot });
  } catch (err) {
    console.error('upload with analyze failed', err);
    return res.status(500).json({ ok: false, message: 'Analysis failed' });
  }
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

// List uploaded files with analysis metadata (non-breaking; new endpoint)
app.get('/api/files/detail', async (_req, res) => {
  try {
    const files = await fs.promises.readdir(uploadDir);
    const withAnalysis = files.map((filename) => {
      const shot = shotStore.getShotByMediaName(filename);
      return {
        filename,
        shotId: shot?.id,
        analysis: shot?.analysis || null,
      };
    });
    res.json({ ok: true, files: withAnalysis });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
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
    shotStore.removeShotByFilename(req.params.name);
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
// Health check folder so frontend can verify backend availability
app.use('/health', express.static(healthDir, { fallthrough: false }));

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
