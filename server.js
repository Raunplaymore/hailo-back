// Swing video upload server for Raspberry Pi
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const {
  buildFrameSequenceFromFile,
  analyzeFrameSequence,
  precheckSwingCandidate,
} = require('./analysis/engine');
const opencvAnalyzer = require('./analyzers/opencvV1');
const shotStore = require('./store/shotStore');
const { parseMeta } = require('./analysis/meta_parser');
const { detectEvents } = require('./analysis/event_detector');
const { calculateMetrics } = require('./analysis/metrics_calculator');
const jobStore = require('./store/job_store');

const app = express();
const PORT = 3000;
// Default to local uploads directory; allow override for Raspberry Pi via env
const uploadDir =
  process.env.UPLOAD_DIR ||
  (fs.existsSync('/home/ray/uploads') ? '/home/ray/uploads' : path.join(__dirname, 'uploads'));
const healthDir = path.join(__dirname, 'health');
const metaDir = process.env.META_DIR || '/tmp';
const cameraBaseUrl = process.env.CAMERA_BASE_URL;
const activeAnalysisJobs = new Set();

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

function uploadsUrl(filename) {
  if (!filename) return undefined;
  return `/uploads/${encodeURIComponent(filename)}`;
}

let ffmpegAvailability;
let ffprobeAvailability;

async function commandAvailable(command) {
  return new Promise((resolve) => {
    const proc = spawn(command, ['-version']);
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

async function ensureFfmpegAvailability() {
  if (ffmpegAvailability === undefined) {
    ffmpegAvailability = await commandAvailable('ffmpeg');
  }
  if (ffprobeAvailability === undefined) {
    ffprobeAvailability = await commandAvailable('ffprobe');
  }
  return { ffmpeg: ffmpegAvailability, ffprobe: ffprobeAvailability };
}

function isSupportedVideoExt(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return (ext === '.mp4' || ext === '.mov') && !filename.endsWith('.part');
}

function isDecodeErrorMessage(message) {
  if (!message) return false;
  const m = String(message).toLowerCase();
  return (
    m.includes('cannot open video') ||
    m.includes('video file not found') ||
    m.includes('moov atom not found') ||
    m.includes('invalid data found') ||
    m.includes('unsupported') ||
    m.includes('decoder') ||
    m.includes('could not find codec parameters')
  );
}

async function runCommand(command, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error(`${command} timeout`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(stderr || `${command} exited with ${code}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

async function getVideoCodecName(videoPath) {
  const { ffprobe } = await ensureFfmpegAvailability();
  if (!ffprobe) return null;
  try {
    const { stdout } = await runCommand(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name',
        '-of',
        'default=nw=1:nk=1',
        videoPath,
      ],
      { timeoutMs: 5000 },
    );
    const codec = stdout.trim();
    return codec || null;
  } catch {
    return null;
  }
}

async function getVideoMeta(videoPath) {
  const { ffprobe } = await ensureFfmpegAvailability();
  if (!ffprobe) return {};
  try {
    const { stdout } = await runCommand(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height,r_frame_rate',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        videoPath,
      ],
      { timeoutMs: 5000 },
    );
    const parsed = JSON.parse(stdout);
    const stream = parsed?.streams?.[0] || {};
    const format = parsed?.format || {};
    const [num, den] = String(stream.r_frame_rate || '0/1').split('/').map(Number);
    const fps = den ? num / den : undefined;
    const durationMs = format.duration ? Math.round(Number(format.duration) * 1000) : undefined;
    return {
      width: stream.width,
      height: stream.height,
      fps: Number.isFinite(fps) ? fps : undefined,
      durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
    };
  } catch {
    return {};
  }
}

async function prepareVideoForAnalysis(originalPath, originalFilename) {
  const ext = path.extname(originalFilename || originalPath || '').toLowerCase();
  if (ext !== '.mov') {
    return { ok: true, path: originalPath, converted: false };
  }

  const { ffmpeg } = await ensureFfmpegAvailability();
  if (!ffmpeg) {
    return {
      ok: true,
      path: originalPath,
      converted: false,
      warning: 'ffmpeg not available; analyzing .mov directly',
    };
  }

  const convertedDir = path.join(uploadDir, '.converted');
  await fs.promises.mkdir(convertedDir, { recursive: true });

  const stats = await fs.promises.stat(originalPath);
  const safeBase = path.basename(originalFilename, ext).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'video';
  const key = `${stats.mtimeMs}-${stats.size}`;
  const outPath = path.join(convertedDir, `${safeBase}-${key}.mp4`);

  if (fs.existsSync(outPath)) {
    return { ok: true, path: outPath, converted: true, conversion: 'cached' };
  }

  const codec = await getVideoCodecName(originalPath);

  // If codec is already h264, remux is fast and lossless; otherwise transcode for compatibility.
  const shouldRemux = codec === 'h264' || codec === null;
  if (shouldRemux) {
    try {
      await runCommand(
        'ffmpeg',
        ['-y', '-i', originalPath, '-c', 'copy', '-movflags', '+faststart', outPath],
        { timeoutMs: 30_000 },
      );
      return { ok: true, path: outPath, converted: true, conversion: 'remux', codec };
    } catch (err) {
      // Fall through to transcode
    }
  }

  try {
    await runCommand(
      'ffmpeg',
      [
        '-y',
        '-i',
        originalPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outPath,
      ],
      { timeoutMs: 120_000 },
    );
    return { ok: true, path: outPath, converted: true, conversion: 'transcode', codec };
  } catch (err) {
    return { ok: false, error: err.message, codec };
  }
}

function toBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value !== 'string') return false;
  return value.toLowerCase() === 'true' || value === '1';
}

function looksLikeAnalysisFailure(analysis) {
  if (!analysis) return false;
  if (analysis.errorMessage) return true;
  if (analysis.errorCode) return true;
  const coach = analysis.coach_summary;
  if (Array.isArray(coach)) {
    return coach.some(
      (line) =>
        typeof line === 'string' && line.toLowerCase().includes('analysis failed'),
    );
  }
  return false;
}

function normalizeJobStatus(status) {
  if (!status) return undefined;
  const v = String(status).toLowerCase();
  if (v === 'queued' || v === 'running' || v === 'succeeded' || v === 'failed') return v;
  if (v === 'success' || v === 'ok') return 'succeeded';
  if (v === 'error' || v === 'failure') return 'failed';
  if (v === 'not-analyzed' || v === 'not_analyzed') return 'not-analyzed';
  return undefined;
}

function buildNotSwingAnalysis(precheckResult) {
  return {
    analysisVersion: opencvAnalyzer.ANALYSIS_VERSION,
    errorCode: 'NOT_SWING',
    errorMessage: '스윙 영상이 아닌 것 같아요. 다시 촬영해 주세요.',
    events: {
      precheck: precheckResult || null,
    },
    swing: null,
    ballFlight: null,
    shot_type: 'unknown',
    coach_summary: ['NOT_SWING: aborted by precheck'],
    analysis_id: randomUUID(),
  };
}

function buildAnalysisFromFrames(frameSeq) {
  return analyzeFrameSequence(frameSeq);
}

function buildJobAnalysisPayload(shot) {
  const analysis = shot.analysis || {};
  const swing = analysis.swing || {};
  const ball = analysis.ballFlight || analysis.impact || {};

  const launchDir = (() => {
    const h = ball.horizontal_launch_direction;
    if (h === null || h === undefined) return 'unknown';
    if (h < -1) return 'left';
    if (h > 1) return 'right';
    return 'center';
  })();

  const tempoRatio =
    swing.tempo_ratio === null || swing.tempo_ratio === undefined
      ? null
      : `${swing.tempo_ratio}:1`;

  return {
    jobId: shot.jobId,
    status: shot.status || 'succeeded',
    analysisVersion: analysis?.analysisVersion,
    errorCode: analysis?.errorCode ?? null,
    events: {
      address: null,
      top: null,
      impact: analysis?.events?.impact,
      finish: null,
    },
    metrics: {
      tempo: {
        backswingMs: swing.backswing_time_ms ?? null,
        downswingMs: swing.downswing_time_ms ?? null,
        ratio: tempoRatio,
      },
      eventTiming: {
        address: null,
        top: null,
        impact: analysis?.events?.impact?.timeMs ?? null,
        finish: null,
      },
      ball: {
        launchDirection: launchDir,
        launchAngle: ball.vertical_launch_angle ?? null,
        speedRelative: 'unknown',
      },
    },
    pending: [
      { key: 'club_tracking', label: '클럽 추적', description: '향후 스윙 이벤트/클럽 경로', status: 'coming-soon' },
    ],
    errorMessage: analysis?.errorMessage,
    meta: analysis?.meta,
  };
}

function mapShotToFileEntry(shot) {
  return {
    id: shot.id,
    filename: shot.media?.filename,
    jobId: shot.jobId,
    status: shot.status || 'succeeded',
    createdAt: shot.createdAt,
    sourceType: shot.sourceType || 'upload',
    videoUrl: uploadsUrl(shot.media?.filename),
    analysis: buildJobAnalysisPayload(shot),
  };
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

const EMPTY_EVENTS = {
  addressMs: null,
  topMs: null,
  impactMs: null,
  finishMs: null,
};

const EMPTY_METRICS = {
  swingPlane: { label: 'neutral', confidence: 0 },
  tempo: { backswingMs: null, downswingMs: null, ratio: null },
  impactStability: { label: 'unstable', score: 0 },
};

function buildAnalysisResult({ events, metrics, summary } = {}) {
  return {
    events: { ...EMPTY_EVENTS, ...(events || {}) },
    metrics: {
      swingPlane: { ...EMPTY_METRICS.swingPlane, ...(metrics?.swingPlane || {}) },
      tempo: { ...EMPTY_METRICS.tempo, ...(metrics?.tempo || {}) },
      impactStability: {
        ...EMPTY_METRICS.impactStability,
        ...(metrics?.impactStability || {}),
      },
    },
    summary: summary || '',
  };
}

function resolveUploadPath(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const resolvedUpload = path.resolve(uploadDir);
  const target = path.resolve(uploadDir, filename);
  if (!target.startsWith(`${resolvedUpload}${path.sep}`)) {
    return null;
  }
  return target;
}

async function fetchMetaFromCamera(jobId) {
  if (!cameraBaseUrl || typeof fetch !== 'function') return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const base = cameraBaseUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/api/session/${jobId}/meta`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadMetaPayload(jobId) {
  const metaPath = path.join(metaDir, `${jobId}.meta.json`);
  if (fs.existsSync(metaPath)) {
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return fetchMetaFromCamera(jobId);
}

async function runMetaAnalysisJob(jobId) {
  const job = jobStore.getJob(jobId);
  if (!job) return;
  if (activeAnalysisJobs.has(jobId)) return;
  activeAnalysisJobs.add(jobId);
  try {
    jobStore.updateJob(jobId, {
      status: 'running',
      startedAt: new Date().toISOString(),
      errorMessage: null,
    });

    const videoPath = resolveUploadPath(job.filename);
    if (!videoPath || !fs.existsSync(videoPath)) {
      const result = buildAnalysisResult({
        summary: 'Video file not found.',
      });
      jobStore.updateJob(jobId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        errorMessage: 'Video file not found',
        result,
      });
      return;
    }

    const metaPayload = await loadMetaPayload(jobId);
    if (!metaPayload) {
      const result = buildAnalysisResult({
        summary: 'Meta file not available.',
      });
      jobStore.updateJob(jobId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        errorMessage: 'Meta file not found',
        result,
      });
      return;
    }

    const { frames } = parseMeta(metaPayload);
    if (!frames.length) {
      const result = buildAnalysisResult({
        summary: 'No frame data available.',
      });
      jobStore.updateJob(jobId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        errorMessage: 'No frame data in meta',
        result,
      });
      return;
    }

    const { events, signals } = detectEvents(frames);
    const { metrics, summary } = calculateMetrics(frames, events, signals);
    const result = buildAnalysisResult({ events, metrics, summary });
    jobStore.updateJob(jobId, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      errorMessage: null,
      result,
    });
  } catch (err) {
    const result = buildAnalysisResult({
      summary: 'Analysis failed.',
    });
    jobStore.updateJob(jobId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      errorMessage: err.message,
      result,
    });
  } finally {
    activeAnalysisJobs.delete(jobId);
  }
}

async function analyzeAndStoreUploadedShot(file, body) {
  const existing = shotStore.getShotByMediaName(file.filename);
  const sourceType = body.sourceType || existing?.sourceType || 'upload';
  const force = toBoolean(body.force);
  const meta = {
    club: body.club,
    fps: toNumberOrUndefined(body.fps),
    cameraConfig: body.cameraConfig,
    roi: body.roi,
    sourceType,
  };

  const prepared = await prepareVideoForAnalysis(file.path, file.filename);
  if (prepared.ok === false) {
    const sessionId = body.sessionId
      ? shotStore.ensureSessionPersisted(
          body.sessionId,
          body.sessionName || 'default',
          { sourceType },
        )
      : existing?.sessionId ||
        shotStore.ensureSessionPersisted(
          undefined,
          body.sessionName || 'default',
          { sourceType },
        );

    const analysis = {
      analysisVersion: opencvAnalyzer.ANALYSIS_VERSION,
      errorCode: 'DECODE_FAILED',
      errorMessage: `영상 디코딩/변환에 실패했습니다. (${prepared.error})`,
      events: {
        conversion: {
          ok: false,
          codec: prepared.codec ?? null,
        },
      },
      swing: null,
      ballFlight: null,
      shot_type: 'unknown',
      coach_summary: ['analysis failed: decode/convert failed'],
      analysis_id: randomUUID(),
    };
    const shot = {
      id: existing?.id || randomUUID(),
      jobId: existing?.jobId || randomUUID(),
      status: 'failed',
      sessionId,
      sourceType,
      createdAt: existing?.createdAt || new Date().toISOString(),
      media: {
        filename: file.filename,
        path: file.path,
        size: file.size,
      },
      metadata: meta,
      analysis,
    };
    shotStore.upsertShot(shot);
    return shot;
  }

  const videoMeta = await getVideoMeta(prepared.path);
  const frameSeq = buildFrameSequenceFromFile(prepared.path, {
    ...meta,
    analysisInput: {
      path: prepared.path,
      converted: Boolean(prepared.converted),
      conversion: prepared.conversion,
      warning: prepared.warning,
    },
  });
  let analysis;
  let abortedByPrecheck = false;
  let precheckResult;
  if (!force) {
    precheckResult = await precheckSwingCandidate(frameSeq, {
      timeoutMs: 1200,
      sampleWindowSec: 1.0,
      sampleFrames: 8,
      minDurationSec: 0.6,
      minFrames: 20,
      motionThreshold: 2.0,
      resizeWidth: 160,
    });
    if (precheckResult?.ok === true && precheckResult?.isSwing === false) {
      abortedByPrecheck = true;
      analysis = buildNotSwingAnalysis({
        ...precheckResult,
        conversion: prepared.converted ? { converted: true, conversion: prepared.conversion } : null,
      });
    }
  }
  if (!abortedByPrecheck) {
    const analyzed = await opencvAnalyzer.analyze(frameSeq);
    const formatted = formatAnalysisForFrontend(analyzed.raw);
    analysis = {
      ...formatted,
      analysisVersion: opencvAnalyzer.ANALYSIS_VERSION,
      meta: {
        fps: videoMeta.fps ?? meta.fps,
        width: videoMeta.width,
        height: videoMeta.height,
        durationMs: videoMeta.durationMs,
      },
      analysisDurationMs: analyzed.durationMs,
    };
    if (prepared.converted) {
      analysis.events = analysis.events || {};
      analysis.events.conversion = {
        converted: true,
        conversion: prepared.conversion,
        warning: prepared.warning,
      };
    }
    if (analysis && !analysis.errorCode && isDecodeErrorMessage(analysis.errorMessage)) {
      analysis.errorCode = 'DECODE_FAILED';
    }
  }

  const sessionId = body.sessionId
    ? shotStore.ensureSessionPersisted(
        body.sessionId,
        body.sessionName || 'default',
        { sourceType },
      )
    : existing?.sessionId ||
      shotStore.ensureSessionPersisted(
        undefined,
        body.sessionName || 'default',
        { sourceType },
      );

  const failed = looksLikeAnalysisFailure(analysis) || !analysis;
  const status = failed ? 'failed' : 'succeeded';

  const shot = {
    id: existing?.id || randomUUID(),
    jobId: existing?.jobId || randomUUID(),
    status,
    sessionId,
    sourceType,
    createdAt: existing?.createdAt || new Date().toISOString(),
    media: {
      filename: file.filename,
      path: file.path,
      size: file.size,
    },
    metadata: { ...meta, video: videoMeta },
    analysis,
  };

  shotStore.upsertShot(shot);
  return shot;
}

// Analyze uploaded video and store shot result
const analyzeUploadHandler = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, message: 'No file uploaded' });
  }

  try {
    const shot = await analyzeAndStoreUploadedShot(req.file, {
      ...(req.body || {}),
      force: toBoolean(req.body?.force) || toBoolean(req.query?.force),
    });
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

  const sourceType = payload.sourceType || 'camera';
  const shot = {
    id: randomUUID(),
    jobId: null,
    status: 'not-analyzed',
    sessionId,
    sourceType,
    createdAt: new Date().toISOString(),
    media: payload.media || {},
    metadata: {
      club: payload.club,
      fps: toNumberOrUndefined(payload.fps),
      cameraConfig: payload.cameraConfig,
    },
    analysis: null,
  };

  shotStore.upsertShot(shot);
  res.json({ ok: true, shot });
};
app.post('/shots', createShotHandler);
app.post('/api/shots', createShotHandler);

// New analyze job creation
app.post('/api/analyze', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  try {
    const shot = await analyzeAndStoreUploadedShot(req.file, {
      ...(req.body || {}),
      force: toBoolean(req.body?.force) || toBoolean(req.query?.force),
    });
    return res.json({
      ok: true,
      jobId: shot.jobId,
      filename: req.file.filename,
      url: uploadsUrl(req.file.filename),
      status: shot.status,
    });
  } catch (err) {
    console.error('analyze job failed', err);
    return res.status(500).json({ error: 'Analysis failed' });
  }
});

// Trigger analysis for an existing file in UPLOAD_DIR (no re-upload)
app.post('/api/analyze/from-file', (req, res) => {
  const payload = req.body || {};
  const providedJobId = typeof payload.jobId === 'string' ? payload.jobId : null;
  const filename = typeof payload.filename === 'string' ? payload.filename : null;
  const force = payload.force === true || toBoolean(payload.force);
  const derivedJobId =
    providedJobId || (filename ? path.basename(filename, path.extname(filename)) : null);
  if (!derivedJobId) {
    return res.status(400).json({ ok: false, message: 'jobId is required' });
  }
  if (derivedJobId.includes('/') || derivedJobId.includes('\\')) {
    return res.status(400).json({ ok: false, message: 'Invalid jobId' });
  }

  const targetFilename = filename || `${derivedJobId}.mp4`;
  if (!isSupportedVideoExt(targetFilename)) {
    return res.status(400).json({ ok: false, message: 'Only .mp4/.mov is supported' });
  }
  if (!resolveUploadPath(targetFilename)) {
    return res.status(400).json({ ok: false, message: 'Invalid file path' });
  }

  const existing = jobStore.getJob(derivedJobId);
  if (existing && !force && ['pending', 'running', 'done'].includes(existing.status)) {
    return res.json({ ok: true, jobId: derivedJobId, status: existing.status });
  }
  if (existing && existing.status === 'running' && force) {
    return res.json({ ok: true, jobId: derivedJobId, status: existing.status });
  }

  const now = new Date().toISOString();
  const job = {
    jobId: derivedJobId,
    filename: targetFilename,
    status: 'pending',
    createdAt: existing?.createdAt || now,
    requestedAt: now,
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
    result: null,
  };
  jobStore.upsertJob(job);
  setImmediate(() => runMetaAnalysisJob(derivedJobId));
  jobStore.updateJob(derivedJobId, { status: 'running', startedAt: now });
  return res.json({ ok: true, jobId: derivedJobId, status: 'running' });
});

function mapLegacyStatus(status) {
  const normalized = normalizeJobStatus(status);
  if (normalized === 'queued' || normalized === 'not-analyzed') return 'pending';
  if (normalized === 'running') return 'running';
  if (normalized === 'succeeded') return 'done';
  if (normalized === 'failed') return 'failed';
  return 'pending';
}

function respondJobStatus(req, res) {
  const jobId = req.params.jobId;
  const job = jobStore.getJob(jobId);
  if (job) {
    const result = buildAnalysisResult(job.result || {});
    const summary = result.summary || (job.status === 'running'
      ? 'Analysis running.'
      : job.status === 'pending'
        ? 'Analysis pending.'
        : job.status === 'failed'
          ? 'Analysis failed.'
          : '');
    return res.json({
      ok: true,
      jobId,
      status: job.status,
      errorMessage: job.errorMessage ?? null,
      events: result.events,
      metrics: result.metrics,
      summary,
    });
  }

  const shot = shotStore.getShotByJobId(jobId);
  if (!shot) {
    return res.status(404).json({ ok: false, message: 'Job not found' });
  }
  const status = mapLegacyStatus(shot.status);
  let summary = '';
  const coach = shot.analysis?.coach_summary;
  if (Array.isArray(coach)) {
    summary = coach.join(' ');
  } else if (typeof coach === 'string') {
    summary = coach;
  } else if (shot.analysis?.errorMessage) {
    summary = shot.analysis.errorMessage;
  }
  const result = buildAnalysisResult({ summary });
  return res.json({
    ok: true,
    jobId,
    status,
    errorMessage: shot.analysis?.errorMessage ?? null,
    events: result.events,
    metrics: result.metrics,
    summary: result.summary,
  });
}

app.get('/api/analyze/:jobId', respondJobStatus);
app.get('/api/analyze/:jobId/result', respondJobStatus);

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
    return res.json({
      ok: true,
      file: req.file.filename,
      url: uploadsUrl(req.file.filename),
      originalName: req.file.originalname,
    });
  }
  try {
    const shot = await analyzeAndStoreUploadedShot(req.file, {
      ...(req.body || {}),
      force: toBoolean(req.body?.force) || toBoolean(req.query?.force),
    });
    return res.json({
      ok: true,
      file: req.file.filename,
      url: uploadsUrl(req.file.filename),
      originalName: req.file.originalname,
      shot,
    });
  } catch (err) {
    console.error('upload with analyze failed', err);
    return res.status(500).json({ ok: false, message: 'Analysis failed' });
  }
});

// List uploaded files
app.get('/api/files', (_req, res) => {
  try {
    const shots = shotStore.listShots();
    const entries = shots.map(mapShotToFileEntry);
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List uploaded mp4 files with analysis status so the frontend can show an "Analyze" button
app.get('/api/files/detail', async (_req, res) => {
  try {
    const entries = await fs.promises.readdir(uploadDir, { withFileTypes: true });
    const videoFiles = entries
      .filter((ent) => ent.isFile() && isSupportedVideoExt(ent.name))
      .map((ent) => ent.name);

    const filesWithStatus = await Promise.all(
      videoFiles.map(async (filename) => {
        const shot = shotStore.getShotByMediaName(filename);
        let stats;
        try {
          stats = await fs.promises.stat(path.join(uploadDir, filename));
	        } catch {
	          // ignore stat errors; keep lightweight listing
	        }
	        const errorCode = shot?.analysis?.errorCode ?? null;
	        const errorMessage = shot?.analysis?.errorMessage ?? null;
	        return {
	          filename,
	          url: uploadsUrl(filename),
	          shotId: shot?.id || null,
	          jobId: shot?.jobId || null,
	          analyzed: normalizeJobStatus(shot?.status) === 'succeeded',
	          status:
	            normalizeJobStatus(shot?.status) ||
	            (shot?.analysis ? (looksLikeAnalysisFailure(shot.analysis) ? 'failed' : 'succeeded') : 'not-analyzed'),
	          errorCode,
	          errorMessage,
	          size: stats?.size,
	          modifiedAt: stats?.mtime?.toISOString(),
	          analysis: shot ? buildJobAnalysisPayload(shot) : null,
	        };
	      }),
	    );

    res.json({ ok: true, files: filesWithStatus });
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
