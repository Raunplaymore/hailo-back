// Swing video upload server for Raspberry Pi
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { spawn } = require('child_process');
const {
  buildFrameSequenceFromFile,
  analyzeFrameSequence,
  precheckSwingCandidate,
} = require('./analysis/engine');
const opencvAnalyzer = require('./analyzers/opencvV1');
const shotStore = require('./store/shotStore');
const {
  createSwingTrackingAnnotationStore,
  validateAnnotationIdentity,
} = require('./store/swingTrackingAnnotations');
const { createNasArchive } = require('./storage/nasArchive');
const { createReviewVideo } = require('./storage/reviewVideo');
const { createImpactReviewCache, matchesVideoIdentity } = require('./store/impactReviewCache');
const { createVideoClock, selectVideoReference } = require('./store/videoClock');

const app = express();
const PORT = Number(process.env.PORT || 3000);
// Default to local uploads directory; allow override for Raspberry Pi via env
const uploadDir =
  process.env.UPLOAD_DIR ||
  (fs.existsSync('/home/ray/uploads') ? '/home/ray/uploads' : path.join(__dirname, 'uploads'));
const dataDir =
  process.env.DATA_DIR ||
  (fs.existsSync('/home/ray/data') ? '/home/ray/data' : path.join(__dirname, 'data'));
const reviewVideoPath = createReviewVideo({ cacheDir: path.join(dataDir, 'review-video'), runCommand });
const metaDir = process.env.META_DIR || '/tmp';
const healthDir = path.join(__dirname, 'health');
const inferBaseUrl = process.env.INFER_BASE_URL || 'http://127.0.0.1:3002';
const cameraBaseUrl = process.env.CAMERA_BASE_URL || 'http://127.0.0.1:3001';
const bodyAnalyzerBaseUrl = process.env.BODY_ANALYZER_BASE_URL || inferBaseUrl;
const inferAnalysisDir = path.join(dataDir, 'analysis');
const analysisCacheDir = process.env.ANALYSIS_CACHE_DIR || path.join(dataDir, 'service-analysis-cache');
const persistentMetaDir = process.env.PERSISTENT_META_DIR || path.join(dataDir, 'meta');
const nasDeletionCursorPath = path.join(dataDir, 'nas-deletion-cursor.json');
// Keep this contract aligned with hailo-infer's emitted result version. A stale
// expectation silently bypasses completed-cache reuse and can submit duplicate work.
const expectedInferAnalysisVersion = process.env.INFER_ANALYSIS_VERSION || 'hailo-coach-service7-v16';
const debugDir = path.join(dataDir, 'debug');
const inferDebugFrameDir = path.join(debugDir, 'infer-frames');
const nasThumbnailDir = path.join(debugDir, 'nas-thumbnails');
const swingTrackingArchiveDir = path.join(dataDir, 'annotations', 'swing-tracking-archive');
const SWING_EVENT_KEYS = ['address', 'takeaway', 'top', 'impact', 'finish'];
const DTL_V2_STALE_RUNNING_MS = 10 * 60 * 1000;
const DTL_V2_TAKEAWAY_PROFILE = 'dtl_v2_73_r1';
const activeDebugFrameRequests = new Map();
const swingTrackingAnnotations = createSwingTrackingAnnotationStore({ dataDir });
const nasArchive = createNasArchive({
  baseUrl: process.env.NAS_ARCHIVE_URL,
  token: process.env.NAS_ARCHIVE_TOKEN,
  timeoutMs: Number(process.env.NAS_ARCHIVE_TIMEOUT_MS || 120_000),
  onStatus: (archiveStatus) => updateNasArchiveStatus(archiveStatus.jobId, archiveStatus),
  onDeleted: (jobId) => setImmediate(() => applyNasDeletion(jobId)),
});

const impactReviews = createImpactReviewCache({
  dataDir,
  run: async (jobId, inputPath, bodyPath) => {
    const response = await inferFetchJson(inferUrl('/v1/impact-review'), {
      method: 'POST', body: { jobId, inputPath, bodyPath, automatic: true, confirmedInput: false }, timeoutMs: 180000,
    });
    if (!response.ok) throw new Error(typeof response.json?.detail === 'string' ? response.json.detail : '임팩트 후보 계산에 실패했습니다.');
    return response.json;
  },
});
function scheduleAutomaticImpact(jobId, inputPath, bodyPath = null) {
  // This queue never changes the legacy coach result, timing metrics or training labels.
  try { return impactReviews.schedule(jobId, inputPath, bodyPath); }
  catch (error) { return Promise.reject(error); }
}
async function hashVideoFile(inputPath) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(inputPath)) hash.update(chunk);
  return hash.digest('hex');
}
function queueAutomaticImpact(jobId, inputPath, bodyPath = null, geometry = null) {
  const metadata = geometry || shotStore.getShotByJobId(jobId)?.metadata;
  if (metadata?.viewpoint === 'face_on' || metadata?.handedness === 'left') return;
  scheduleAutomaticImpact(jobId, inputPath, bodyPath).catch((error) => console.warn(`[impact-candidate] ${jobId}: ${error.message}`));
}

function queueAutomaticImpactWithAvailableBody(jobId, inputPath, geometry = null) {
  const bodyPath = bodyArtifactPath(jobId);
  queueAutomaticImpact(jobId, inputPath, fs.existsSync(bodyPath) ? bodyPath : null, geometry);
}

function registerFileImpact(jobId, filename, inputPath, geometry) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId) || !fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) return;
  const previous = shotStore.getShotByMediaName(filename);
  const metadata = { ...previous?.metadata };
  for (const key of ['viewpoint', 'handedness']) {
    if (geometry[key] !== 'unknown') metadata[key] = geometry[key];
  }
  metadata.analysisInput ||= { path: inputPath, converted: false };
  shotStore.upsertShot({
    ...previous, id: previous?.id || randomUUID(), jobId,
    sourceType: previous?.sourceType || 'camera', status: previous?.status || 'not-analyzed',
    createdAt: previous?.createdAt || new Date().toISOString(),
    media: previous?.media || { filename, path: inputPath, size: fs.statSync(inputPath).size },
    metadata,
  });
  queueAutomaticImpactWithAvailableBody(jobId, metadata.analysisInput.path, metadata);
}

// Ensure upload directory exists
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(inferAnalysisDir, { recursive: true });
fs.mkdirSync(analysisCacheDir, { recursive: true });
fs.mkdirSync(persistentMetaDir, { recursive: true });
fs.mkdirSync(inferDebugFrameDir, { recursive: true });
fs.mkdirSync(nasThumbnailDir, { recursive: true });
fs.mkdirSync(swingTrackingArchiveDir, { recursive: true });
fs.mkdirSync(healthDir, { recursive: true });

// Configure multer storage: timestamp prefix keeps uploads unique
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) =>
    cb(null, `${Date.now()}-${randomUUID()}-${file.originalname}`),
});

const upload = multer({ storage, limits: { fields: 64, fieldNestingDepth: 4, fieldArrayIndexLimit: 1024 } });
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

async function runCommand(command, args, { timeoutMs = 30_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, signal ? { signal } : undefined);
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

async function prepareVideoForAnalysis(originalPath, originalFilename, retryJobId = null) {
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
  if (retryJobId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(retryJobId)) throw new Error('Invalid retry job ID');
  const outPath = path.join(convertedDir, `${safeBase}-${key}${retryJobId ? `-${retryJobId}` : ''}.mp4`);

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
  if (analysis.errorCode) return true;
  if (analysis.errorMessage && !analysis.warningCode) return true;
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
  const progress = analysis.progress || shot.progress || null;
  const swing = analysis.swing || {};
  const ball = analysis.ballFlight || analysis.impact || {};
  const swingPlane = analysis.swing_plane || analysis.swingPlane || null;
  const impactStability = analysis.impact_stability || analysis.impactStability || null;
  const summary =
    analysis.summary ||
    (Array.isArray(analysis.coach_summary) ? analysis.coach_summary.join(' · ') : null) ||
    (Array.isArray(analysis.coachSummary) ? analysis.coachSummary.join(' · ') : null) ||
    null;
  const coachSummary =
    Array.isArray(analysis.coach_summary)
      ? analysis.coach_summary
      : Array.isArray(analysis.coachSummary)
        ? analysis.coachSummary
        : [];
  const confidence =
    typeof analysis.confidence === 'number'
      ? analysis.confidence
      : typeof analysis.confidence === 'string'
        ? Number(analysis.confidence)
        : null;

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
      takeaway: null,
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
        takeaway: null,
        top: null,
        impact: analysis?.events?.impact?.timeMs ?? null,
        finish: null,
      },
      ball: {
        launchDirection: launchDir,
        launchAngle: ball.vertical_launch_angle ?? null,
        speedRelative: 'unknown',
      },
      swingPlane,
      impactStability,
    },
    pending: DEFAULT_PENDING_ITEMS,
    summary,
    coachSummary,
    coachFindings: Array.isArray(analysis.coachFindings) ? analysis.coachFindings : [],
    confidence: Number.isFinite(confidence) ? confidence : null,
    errorMessage: analysis?.errorMessage,
    meta: analysis?.meta,
    progress,
  };
}

function mapShotToFileEntry(shot) {
  const analysis = buildJobAnalysisPayload(shot);
  return {
    id: shot.id,
    filename: shot.media?.filename,
    jobId: shot.jobId,
    status: analysis?.status || shot.status || 'succeeded',
    createdAt: shot.createdAt,
    sourceType: shot.sourceType || 'upload',
    videoUrl: uploadsUrl(shot.media?.filename),
    thumbnailUrl: localThumbnailUrl(shot.jobId),
    analysis,
    progress: analysis?.progress || shot.progress || null,
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

const DEFAULT_PENDING_ITEMS = [
  { key: 'pelvis_pose', label: '골반 회전', description: '포즈 키포인트 모델 연동 후 직접 판정', status: 'coming-soon' },
  { key: 'attack_angle', label: 'Attack Angle', description: '정면/측면 보정값 확보 후 제공', status: 'coming-soon' },
];

function resolveUploadPath(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const resolvedUpload = path.resolve(uploadDir);
  const target = path.resolve(uploadDir, filename);
  if (!target.startsWith(`${resolvedUpload}${path.sep}`)) {
    return null;
  }
  return target;
}

function resolveMetaPath(metaPath, jobId) {
  const candidate = metaPath || (jobId ? path.join(metaDir, `${jobId}.meta.json`) : null);
  if (!candidate || typeof candidate !== 'string') return null;
  const resolvedMetaDir = path.resolve(metaDir);
  const target = path.resolve(candidate);
  if (!target.startsWith(`${resolvedMetaDir}${path.sep}`)) {
    return null;
  }
  return target;
}

function persistentMetaPath(jobId, variant = 'main') {
  if (!isSafeJobId(jobId)) return null;
  const suffix = variant === 'debug' ? '.debug.meta.json' : '.meta.json';
  return path.join(persistentMetaDir, `${jobId}${suffix}`);
}

function persistMetaArtifact(jobId, sourceMetaPath, variant = 'main') {
  const target = persistentMetaPath(jobId, variant);
  const source = resolveMetaPath(sourceMetaPath, jobId);
  if (!target || !source || !fs.existsSync(source)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (!Array.isArray(payload?.frames) || payload.frames.length === 0) return null;
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
    fs.renameSync(temporary, target);
    return target;
  } catch (error) {
    console.warn(`[meta] unable to persist ${jobId}: ${error.message}`);
    return null;
  }
}

async function restoreMetaArtifactFromNas(jobId, variant = 'main') {
  if (variant !== 'main' || !nasArchive.enabled || !isSafeJobId(jobId)) return null;
  const target = persistentMetaPath(jobId, variant);
  if (!target) return null;
  try {
    const response = await nasArchive.downloadArtifact(jobId, 'meta', 'meta.json');
    if (!response) return null;
    const payload = JSON.parse(await response.text());
    if (!Array.isArray(payload?.frames) || payload.frames.length === 0) return null;
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(payload), 'utf8');
    await fs.promises.rename(temporary, target);
    console.info(`[meta] restored ${jobId} from NAS archive`);
    return target;
  } catch (error) {
    console.warn(`[meta] unable to restore ${jobId} from NAS: ${error.message}`);
    return null;
  }
}

async function waitForFile(filePath, timeoutMs = 2000) {
  if (!filePath) return false;
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

function analysisCachePath(jobId) {
  if (!jobId) return null;
  return path.join(analysisCacheDir, `${jobId}.json`);
}

function inferAnalysisPath(jobId) {
  if (!jobId) return null;
  return path.join(inferAnalysisDir, `${jobId}.json`);
}

function bodyArtifactPath(jobId) {
  if (!jobId) return null;
  return path.join(dataDir, 'body', `${jobId}.json`);
}

function looksLikeServiceAnalysisCache(payload) {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      ('analysis' in payload || 'progress' in payload || 'updatedAt' in payload || 'metaPath' in payload),
  );
}

function readAnalysisCache(jobId) {
  const cachePath = analysisCachePath(jobId);
  if (!cachePath) return null;
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    // Older pi_service builds wrote their wrapper cache into DATA_DIR/analysis,
    // which is also hailo-infer's raw result directory. Only read legacy files
    // that look like pi_service wrapper cache; otherwise leave infer results alone.
    const legacyPath = inferAnalysisPath(jobId);
    if (!legacyPath || legacyPath === cachePath) return null;
    try {
      const raw = fs.readFileSync(legacyPath, 'utf8');
      const parsed = JSON.parse(raw);
      return looksLikeServiceAnalysisCache(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function isSafeJobId(jobId) {
  return typeof jobId === 'string' && jobId.length > 0 && jobId !== '.' && jobId !== '..' && !jobId.includes('/') && !jobId.includes('\\');
}

function localThumbnailUrl(jobId) {
  if (!isSafeJobId(jobId)) return null;
  const thumbnailPath = path.join(nasThumbnailDir, `${jobId}.jpg`);
  return fs.existsSync(thumbnailPath)
    ? `/debug/nas-thumbnails/${encodeURIComponent(jobId)}.jpg`
    : null;
}

async function readJsonFile(filePath) {
  if (!filePath) return null;
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function hydrateOverlayFromBodyArtifact(analysis, bodyPath) {
  if (!analysis || analysis.overlay || !bodyPath) return analysis;
  const body = await readJsonFile(bodyPath);
  const frames = Array.isArray(body?.frames) ? body.frames : [];
  const poseFrames = frames
    .filter((frame) => frame?.keypoints && typeof frame.keypoints === 'object')
    .map((frame, index) => ({
      timeMs: Number(frame.timeMs ?? index * 33.333),
      frame: Number(frame.frameIndex ?? index),
      keypoints: frame.keypoints,
    }))
    .filter((frame) => Number.isFinite(frame.timeMs));
  if (!poseFrames.length) return analysis;
  analysis.overlay = { coordinateSpace: 'normalized', poseFrames, clubFrames: [] };
  return analysis;
}

function resolveDebugMetaPath(jobId, variant) {
  const persistentPath = persistentMetaPath(jobId, variant);
  if (persistentPath && fs.existsSync(persistentPath)) return persistentPath;
  if (variant === 'debug') {
    const debugMetaPath = resolveMetaPath(path.join(metaDir, `${jobId}.debug.meta.json`), jobId);
    if (debugMetaPath && fs.existsSync(debugMetaPath)) return debugMetaPath;
  }
  const shot = shotStore.getShotByJobId(jobId);
  const cached = readAnalysisCache(jobId);
  return (
    resolveMetaPath(cached?.progress?.metaPath, jobId) ||
    resolveMetaPath(cached?.metaPath, jobId) ||
    resolveMetaPath(shot?.progress?.metaPath, jobId) ||
    resolveMetaPath(shot?.metadata?.metaPath, jobId) ||
    resolveMetaPath(null, jobId)
  );
}

function resolveDebugVideoPath(jobId) {
  const shot = shotStore.getShotByJobId(jobId);
  if (shot?.media?.path && fs.existsSync(shot.media.path)) {
    return shot.media.path;
  }
  if (shot?.media?.filename) {
    const uploadPath = resolveUploadPath(shot.media.filename);
    if (uploadPath && fs.existsSync(uploadPath)) return uploadPath;
  }
  return null;
}

function frameTimeMs(frame, index, fps) {
  const frameIndex = Number(frame?.frame ?? frame?.frameIndex ?? index);
  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : 30;
  if (Number.isFinite(frameIndex) && frameIndex >= 0) {
    return Math.max(0, Math.round((frameIndex * 1000) / safeFps));
  }
  const direct = Number(frame?.t ?? frame?.timeMs ?? frame?.timestampMs);
  return Number.isFinite(direct) ? Math.max(0, Math.round(direct)) : 0;
}

function mapDebugSourceFrames(frames, times) {
  if (!frames.length || !Array.isArray(times) || !times.length ||
      !times.every((time, i) => Number.isFinite(time) && time >= 0 && (i === 0 || time > times[i - 1])) ||
      !frames.every((frame, i) => Number.isFinite(frame?.sourceTimeMs) && frame.sourceTimeMs >= 0 &&
        (i === 0 || frame.sourceTimeMs > frames[i - 1].sourceTimeMs))) return null;
  const mapped = [];
  let next = 0;
  for (const frame of frames) {
    while (next < times.length && times[next] < frame.sourceTimeMs) next += 1;
    const candidates = [next - 1, next].filter((i) => i >= 0 && i < times.length)
      .map((i) => ({ index: i, error: Math.abs(times[i] - frame.sourceTimeMs) }))
      .sort((a, b) => a.error - b.error);
    const best = candidates[0];
    if (!best || best.error > 1.1 || (candidates[1] && Math.abs(best.error - candidates[1].error) < 0.001) ||
        (mapped.length && best.index <= mapped[mapped.length - 1])) return null;
    mapped.push(best.index);
  }
  return mapped;
}

function markSourceFrameGaps(overlay, frames, times) {
  const unknown = { overlay, verified: false, missingFrames: null };
  if (overlay?.clubTimeSource !== 'video_pts' || !Array.isArray(overlay.clubFrames) || !overlay.clubFrames.length
      || !Array.isArray(frames) || !frames.length || frames.length > 7200
      || !Array.isArray(times) || times.length < 4 || times.length > 7200 || times[0] !== 0
      || !times.every((t, i) => Number.isFinite(t) && t >= 0 && t <= 30000 && (!i || t - times[i - 1] > 2.2))) return unknown;
  const metaIndices = mapDebugSourceFrames(frames, times);
  const overlayIndices = mapDebugSourceFrames(overlay.clubFrames.map(row => ({ sourceTimeMs: row?.timeMs })), times);
  if (!metaIndices || !overlayIndices) return unknown;
  const sourceByFrame = new Map();
  for (const [index, frame] of frames.entries()) {
    const id = frame.frame == null ? index : frame.frame;
    if (!Number.isSafeInteger(id) || id < 0 || sourceByFrame.has(id)) return unknown;
    sourceByFrame.set(id, metaIndices[index]);
  }
  if (overlay.clubFrames.some((row, i) => !Number.isSafeInteger(row.frame)
      || sourceByFrame.get(row.frame) !== overlayIndices[i])) return unknown;
  const present = new Set(metaIndices);
  const missing = times.map((_, i) => i).filter(i => !present.has(i));
  const result = { ...overlay, clubFrames: overlay.clubFrames.map((row, i) => ({ ...row, timeMs: times[overlayIndices[i]] })) };
  const stopTimes = [];
  for (const row of result.clubFrames) for (const key of ['head', 'handle']) {
    const field = `${key}ValidUntilMs`;
    if (!(field in row)) continue;
    if (!Number.isFinite(row[field])) return unknown;
    stopTimes.push(row[field]);
  }
  const uniqueStops = [...new Set(stopTimes)].sort((a, b) => a - b);
  const stopIndices = uniqueStops.length
    ? mapDebugSourceFrames(uniqueStops.map(sourceTimeMs => ({ sourceTimeMs })), times) : [];
  if (!stopIndices) return unknown;
  const stopByTime = new Map(uniqueStops.map((time, i) => [time, stopIndices[i]]));
  for (const [i, row] of result.clubFrames.entries()) {
    for (const key of ['head', 'handle']) {
      const field = `${key}ValidUntilMs`;
      if (!(field in row)) continue;
      const sourceIndex = stopByTime.get(row[field]);
      if (sourceIndex === undefined || sourceIndex <= overlayIndices[i]) return unknown;
      row[field] = times[sourceIndex];
    }
  }
  let cursor = 0;
  for (let i = 0; i < overlayIndices.length; i += 1) {
    while (cursor < missing.length && missing[cursor] <= overlayIndices[i]) cursor += 1;
    const next = overlayIndices[i + 1] ?? times.length;
    if (cursor >= missing.length || missing[cursor] >= next) continue;
    for (const key of ['head', 'handle']) {
      const field = `${key}ValidUntilMs`;
      const prior = result.clubFrames[i][field];
      result.clubFrames[i][field] = Number.isFinite(prior) ? Math.min(prior, times[missing[cursor]]) : times[missing[cursor]];
      if (i + 1 < result.clubFrames.length) result.clubFrames[i + 1][`${key}BreakBefore`] = true;
    }
  }
  return { overlay: result, verified: true, missingFrames: missing.length };
}

async function verifyClubSourceCoverage({ jobId, metaPath, metaIdentity, inputPath, videoIdentity, overlay, impact }) {
  const unknown = { status: 'unverified', overlay };
  if (!metaIdentity || !videoIdentity || impact?.jobId !== jobId || impact?.timingRevision !== 3
      || !/^[a-f0-9]{64}$/.test(impact?.videoSha256 ?? '')) return unknown;
  const safePath = resolveMetaPath(metaPath, jobId);
  if (!safePath) return unknown;
  try {
    const before = await fs.promises.lstat(safePath);
    if (!before.isFile() || before.size > 32 * 1024 * 1024 || !matchesVideoIdentity(metaIdentity, before)) return unknown;
    const metadata = JSON.parse(await fs.promises.readFile(safePath, 'utf8'));
    const after = await fs.promises.lstat(safePath);
    const video = await fs.promises.stat(inputPath);
    if (!matchesVideoIdentity(metaIdentity, after) || !matchesVideoIdentity(videoIdentity, video)) return unknown;
    const marked = markSourceFrameGaps(overlay, metadata?.frames, impact.frameTimesMs);
    return marked.verified ? { status: 'verified', missingFrames: marked.missingFrames, overlay: marked.overlay } : unknown;
  } catch { return unknown; }
}

async function debugSourceTimeline(jobId, videoPath, frames, signal) {
  let times = null;
  const cached = impactReviews.read(jobId);
  try {
    const stat = await fs.promises.stat(videoPath);
    if ([2, 3].includes(cached?.result?.timingRevision) && cached.inputPath &&
        path.resolve(cached.inputPath) === path.resolve(videoPath) &&
        matchesVideoIdentity(cached, stat)) {
      times = cached.result.frameTimesMs;
    }
  } catch { /* The probe below will report an unreadable video. */ }
  if (!Array.isArray(times)) {
    const { ffprobe } = await ensureFfmpegAvailability();
    if (!ffprobe) return null;
    try {
      const { stdout } = await runCommand('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time',
        '-of', 'json', videoPath,
      ], { timeoutMs: 30_000, signal });
      times = JSON.parse(stdout).frames.map((frame) =>
        typeof frame.best_effort_timestamp_time === 'string' && frame.best_effort_timestamp_time.trim()
          ? Number(frame.best_effort_timestamp_time) * 1000 : NaN);
      times = times.map((time) => time - times[0]);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      return null;
    }
  }
  if (!Array.isArray(times) || !times.length || !times.every((time, i) =>
    Number.isFinite(time) && time >= 0 && (i === 0 || time > times[i - 1]))) return null;
  const indices = mapDebugSourceFrames(frames, times);
  if (indices) return { indices, times, sourceAligned: true };
  const estimated = frames.map((frame, index) => {
    const frameIndex = Number(frame?.frame ?? frame?.frameIndex ?? index);
    return Number.isFinite(frameIndex) ? Math.round(frameIndex) : index;
  });
  if (!estimated.every((index, i) => index >= 0 && index < times.length && (i === 0 || index > estimated[i - 1]))) return null;
  return { indices: estimated, times, sourceAligned: false };
}

function selectDebugFrames(frames, limit) {
  if (!Array.isArray(frames) || frames.length === 0) return [];
  const safeLimit = Math.max(1, Math.min(240, Number(limit) || 120));
  if (frames.length <= safeLimit) {
    return frames.map((frame, index) => ({ frame, index }));
  }
  const selected = [];
  const seen = new Set();
  for (let i = 0; i < safeLimit; i += 1) {
    const index = Math.round((i * (frames.length - 1)) / Math.max(1, safeLimit - 1));
    if (seen.has(index)) continue;
    seen.add(index);
    selected.push({ frame: frames[index], index });
  }
  return selected;
}

function normalizeDebugDetection(det) {
  if (!det || typeof det !== 'object') return null;
  const bbox = Array.isArray(det.bbox) ? det.bbox.map(Number) : null;
  if (!bbox || bbox.length < 4 || bbox.some((value) => !Number.isFinite(value))) return null;
  const label = det.label ?? det.class ?? det.className ?? det.name ?? det.classId ?? 'unknown';
  const confidence = Number(det.conf ?? det.confidence ?? det.score ?? 0);
  return {
    label: String(label || 'unknown'),
    classId: det.classId ?? det.class_id ?? null,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    bbox: bbox.slice(0, 4),
  };
}

const DEBUG_TRACK_VALIDATION = {
  golf_ball: { maxArea: 0.012, maxWidth: 0.14, maxHeight: 0.14 },
  club_head: { maxArea: 0.02, maxWidth: 0.18, maxHeight: 0.18, maxWristDistance: 0.32 },
  club_handle: { maxArea: 0.06, maxWidth: 0.22, maxHeight: 0.18, maxWristDistance: 0.22 },
  club: { maxArea: 0.08, maxWidth: 0.28, maxHeight: 0.22, maxWristDistance: 0.34 },
};

function debugWristPoints(bodyFrame) {
  const keypoints = bodyFrame?.keypoints;
  if (!keypoints || typeof keypoints !== 'object') return [];
  return ['left_wrist', 'right_wrist']
    .map((key) => keypoints[key])
    .filter((point) => Array.isArray(point) && point.length >= 3)
    .map(([x, y, confidence]) => ({ x: Number(x), y: Number(y), confidence: Number(confidence) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.confidence >= 0.25);
}

function validateDebugDetection(det, bodyFrame) {
  const rule = DEBUG_TRACK_VALIDATION[det?.label];
  if (!rule) return { accepted: true, reason: null };
  const [x, y, width, height] = det.bbox;
  const area = width * height;
  if (width <= 0 || height <= 0 || area > rule.maxArea || width > rule.maxWidth || height > rule.maxHeight) {
    return { accepted: false, reason: 'implausible_bbox_size' };
  }
  if (!Number.isFinite(rule.maxWristDistance)) return { accepted: true, reason: null };
  const wrists = debugWristPoints(bodyFrame);
  if (!wrists.length) return { accepted: false, reason: 'wrist_pose_unavailable' };
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const wristDistance = Math.min(...wrists.map((wrist) => Math.hypot(centerX - wrist.x, centerY - wrist.y)));
  if (wristDistance > rule.maxWristDistance) return { accepted: false, reason: 'too_far_from_wrist' };
  return { accepted: true, reason: null, wristDistance: Number(wristDistance.toFixed(4)) };
}

async function extractDebugFrameImageByTime(videoPath, outPath, timeMs, signal) {
  if (fs.existsSync(outPath)) return;
  const { ffmpeg } = await ensureFfmpegAvailability();
  if (!ffmpeg) {
    throw new Error('ffmpeg not available');
  }
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  const seconds = Math.max(0, Number(timeMs) || 0) / 1000;
  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-ss',
      seconds.toFixed(3),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=w=720:h=720:force_original_aspect_ratio=decrease',
      '-q:v',
      '3',
      outPath,
    ],
    { timeoutMs: 20_000, signal },
  );
}

async function extractDebugFrameImage(videoPath, outPath, { timeMs, frameIndex, signal }) {
  if (fs.existsSync(outPath)) return;
  const { ffmpeg } = await ensureFfmpegAvailability();
  if (!ffmpeg) {
    throw new Error('ffmpeg not available');
  }
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  const numericFrame = Number(frameIndex);
  if (Number.isFinite(numericFrame) && numericFrame >= 0) {
    try {
      await runCommand(
        'ffmpeg',
        [
          '-y',
          '-i',
          videoPath,
          '-vf',
          `select=eq(n\\,${Math.round(numericFrame)}),scale=w=720:h=720:force_original_aspect_ratio=decrease`,
          '-frames:v',
          '1',
          '-vsync',
          '0',
          '-q:v',
          '3',
          outPath,
        ],
        { timeoutMs: 25_000, signal },
      );
      return;
    } catch (error) {
      await fs.promises.rm(outPath, { force: true }).catch(() => {});
      if (signal?.aborted || error?.name === 'AbortError') throw error;
    }
  }
  await extractDebugFrameImageByTime(videoPath, outPath, timeMs, signal);
}

const PROGRESS_STAGE_META = {
  upload_received: {
    label: '업로드 완료',
    message: '파일이 서버에 등록되었습니다.',
    analysisPath: 'pending',
  },
  video_preparing: {
    label: '영상 준비',
    message: '분석 가능한 형식으로 영상을 준비합니다.',
    analysisPath: 'pending',
  },
  video_ready: {
    label: '영상 준비 완료',
    message: '분석 입력 영상 준비가 끝났습니다.',
    analysisPath: 'pending',
  },
  pose_running: {
    label: '몸 분석 실행',
    message: 'pose 기반 body track을 생성합니다.',
    analysisPath: 'pending',
  },
  pose_ready: {
    label: '몸 분석 완료',
    message: 'body track 준비가 완료되었습니다.',
    analysisPath: 'pending',
  },
  club_running: {
    label: '클럽 분석 실행',
    message: 'Hailo club track을 생성합니다.',
    analysisPath: 'infer',
  },
  club_ready: {
    label: '클럽 분석 완료',
    message: 'club track 준비가 완료되었습니다.',
    analysisPath: 'infer',
  },
  fusion_running: {
    label: '융합 분석 실행',
    message: 'body/club 데이터를 결합해 이벤트와 지표를 계산합니다.',
    analysisPath: 'infer',
  },
  fusion_succeeded: {
    label: '융합 분석 완료',
    message: 'body/club 융합 분석 결과를 정리했습니다.',
    analysisPath: 'infer',
  },
  meta_generation_requested: {
    label: '메타 생성 요청',
    message: '카메라 서버에 service7 메타 생성을 요청했습니다.',
    analysisPath: 'infer',
  },
  meta_ready: {
    label: '메타 준비 완료',
    message: 'service7 추론용 메타 파일이 준비되었습니다.',
    analysisPath: 'infer',
  },
  infer_submitting: {
    label: '추론 제출',
    message: 'hailo-infer에 service7 분석 작업을 제출합니다.',
    analysisPath: 'infer',
  },
  infer_pending: {
    label: '추론 대기',
    message: 'service7 추론 작업이 대기열에 등록되었습니다.',
    analysisPath: 'infer',
  },
  infer_running: {
    label: '추론 실행',
    message: 'service7 추론이 진행 중입니다.',
    analysisPath: 'infer',
  },
  infer_succeeded: {
    label: '추론 완료',
    message: 'service7 추론 결과를 수집했습니다.',
    analysisPath: 'infer',
  },
  fallback_opencv: {
    label: '대체 분석 전환',
    message: 'service7 경로를 사용하지 못해 OpenCV 분석으로 전환합니다.',
    analysisPath: 'opencv',
  },
  opencv_precheck: {
    label: '스윙 사전 확인',
    message: 'OpenCV 분석 전 스윙 후보 여부를 확인합니다.',
    analysisPath: 'opencv',
  },
  opencv_running: {
    label: 'OpenCV 분석 실행',
    message: 'OpenCV 기반 스윙 지표를 계산합니다.',
    analysisPath: 'opencv',
  },
  opencv_succeeded: {
    label: 'OpenCV 분석 완료',
    message: 'OpenCV 기반 분석 결과를 정리했습니다.',
    analysisPath: 'opencv',
  },
  failed: {
    label: '분석 실패',
    message: '분석 처리 중 오류가 발생했습니다.',
    analysisPath: 'unknown',
  },
};

function buildAnalysisProgress(stage, patch = {}) {
  const defaults = PROGRESS_STAGE_META[stage] || {};
  return {
    stage,
    stageLabel: patch.stageLabel || defaults.label || stage,
    message: patch.message || defaults.message || null,
    analysisPath: patch.analysisPath || defaults.analysisPath || 'unknown',
    metaPath: patch.metaPath || null,
    bodyPath: patch.bodyPath || null,
    clubPath: patch.clubPath || null,
    fusionPath: patch.fusionPath || null,
    detail: patch.detail || null,
  };
}

function buildGroupedProgress(stage, patch = {}) {
  const baseDetail = patch.detail && typeof patch.detail === 'object' ? patch.detail : {};
  const bodyPipeline = patch.bodyPath
    ? 'available'
    : baseDetail.bodySkipped === true
      ? 'skipped'
      : baseDetail.bodyReason || (Number.isFinite(baseDetail.bodyStatus) && baseDetail.bodyStatus > 0)
        ? 'failed'
        : bodyAnalyzerBaseUrl
          ? 'configured'
          : 'not-configured';
  return buildAnalysisProgress(stage, {
    ...patch,
    detail: {
      ...baseDetail,
      bodyPipeline,
      clubPipeline: 'service7-meta',
      fusionPipeline: patch.analysisPath === 'infer' ? 'hailo-infer' : 'unknown',
    },
  });
}

function mergeAnalysisCache(jobId, patch) {
  const prev = readAnalysisCache(jobId) || {};
  const next = {
    ...prev,
    ...patch,
    progress: patch.progress ? patch.progress : prev.progress || null,
  };
  return writeAnalysisCache(jobId, next);
}

function writeAnalysisCache(jobId, cache, { scheduleArchive = true } = {}) {
  const cachePath = analysisCachePath(jobId);
  if (!cachePath || !cache) return null;
  const sourceMetaPath = cache.metaPath || cache.progress?.metaPath;
  const persistedMetaPath = persistMetaArtifact(jobId, sourceMetaPath);
  const payload = {
    jobId,
    ...cache,
    persistentMetaPath: persistedMetaPath || cache.persistentMetaPath || null,
    updatedAt: new Date().toISOString(),
  };
  // A poller, upload request, and NAS status callback may all update this file.
  // Atomic replacement prevents a reboot or concurrent reader from observing
  // partial JSON while preserving the existing simple JSON-cache contract.
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(temporaryPath, cachePath);
  if (scheduleArchive) queueNasArchive(payload);
  return payload;
}

function updateNasArchiveStatus(jobId, patch) {
  const cache = readAnalysisCache(jobId);
  if (!cache) return null;
  return writeAnalysisCache(
    jobId,
    {
      ...cache,
      nasArchive: {
        ...(cache.nasArchive && typeof cache.nasArchive === 'object' ? cache.nasArchive : {}),
        ...patch,
        updatedAt: patch.updatedAt || new Date().toISOString(),
      },
    },
    { scheduleArchive: false },
  );
}

function isNasArchiveComplete(archive) {
  return archive?.state === 'stored';
}

function archiveThumbnailTimeMs(cache) {
  const events = cache?.analysis?.events || cache?.analysis || {};
  const topMs = Number(events?.eventTiming?.top ?? events?.topMs ?? events?.top);
  return Number.isFinite(topMs) && topMs >= 0 ? topMs : 500;
}

async function createNasThumbnail(cache, videoPath) {
  if (!videoPath || !fs.existsSync(videoPath)) return null;
  const thumbnailPath = path.join(nasThumbnailDir, `${cache.jobId}.jpg`);
  try {
    await extractDebugFrameImageByTime(videoPath, thumbnailPath, archiveThumbnailTimeMs(cache));
    return fs.existsSync(thumbnailPath) ? thumbnailPath : null;
  } catch (error) {
    console.warn(`[nas-archive] thumbnail skipped for ${cache.jobId}: ${error.message}`);
    return null;
  }
}

function queueNasArchive(cache, { force = false } = {}) {
  if (!['done', 'failed'].includes(cache?.status) || !cache?.jobId) return false;
  if (!nasArchive.enabled) {
    updateNasArchiveStatus(cache.jobId, {
      state: 'disabled',
      error: 'NAS archive is not configured',
      retryAt: null,
    });
    return false;
  }
  const current = cache.nasArchive && typeof cache.nasArchive === 'object' ? cache.nasArchive : {};
  if (!force && (isNasArchiveComplete(current) || ['pending', 'uploading', 'retrying'].includes(current.state))) return false;
  const shot = shotStore.getShotByJobId(cache.jobId);
  const durableMetaPath = persistentMetaPath(cache.jobId);
  const metaPath =
    cache.persistentMetaPath ||
    (durableMetaPath && fs.existsSync(durableMetaPath) ? durableMetaPath : null) ||
    cache.metaPath ||
    cache.progress?.metaPath ||
    shot?.metadata?.metaPath;
  const bodyPath = cache.progress?.bodyPath || bodyArtifactPath(cache.jobId);
  const artifacts = [
    { artifact: 'video', filePath: resolveDebugVideoPath(cache.jobId) },
    { artifact: 'analysis-cache', filePath: analysisCachePath(cache.jobId) },
    { artifact: 'analysis-result', filePath: inferAnalysisPath(cache.jobId) },
    { artifact: 'body', filePath: bodyPath },
    { artifact: 'meta', filePath: metaPath },
  ];
  const scheduled = nasArchive.schedule({
    jobId: cache.jobId,
    status: cache.status,
    shot,
    cache,
    artifacts,
    prepareArtifacts: async (baseArtifacts) => {
      const thumbnailPath = await createNasThumbnail(cache, resolveDebugVideoPath(cache.jobId));
      return thumbnailPath
        ? [...baseArtifacts, { artifact: 'thumbnail', filePath: thumbnailPath }]
        : baseArtifacts;
    },
  });
  if (scheduled) {
    updateNasArchiveStatus(cache.jobId, {
      state: 'pending',
      attempt: current.attempt || 0,
      retryAt: null,
      error: null,
      updatedAt: new Date().toISOString(),
    });
  }
  return scheduled;
}

async function queueLabNasArchive({ jobId, inputPath, sourceVideoPath, bodyPath, labResult }) {
  const workspace = path.dirname(labResult.scorePath || '');
  if (!workspace || !fs.existsSync(workspace)) return { state: 'unavailable', error: 'lab workspace missing' };
  const archiveJobId = `lab-${jobId}`;
  const run = await readJsonFile(path.join(workspace, 'run.json'));
  const metaPaths = run?.metaPaths && typeof run.metaPaths === 'object' ? run.metaPaths : {};
  const artifacts = [
    { artifact: 'lab-input-video', filePath: inputPath },
    { artifact: 'lab-body', filePath: bodyPath },
    { artifact: 'lab-score', filePath: labResult.scorePath },
    { artifact: 'lab-run', filePath: path.join(workspace, 'run.json') },
    { artifact: 'lab-variants', filePath: path.join(workspace, 'variants.json') },
    { artifact: 'lab-contrast-video', filePath: path.join(workspace, 'contrast.mp4') },
    { artifact: 'lab-wrist-roi-video', filePath: path.join(workspace, 'wrist-roi.mp4') },
    { artifact: 'lab-source-meta', filePath: metaPaths.source },
    { artifact: 'lab-contrast-meta', filePath: metaPaths.contrast },
    { artifact: 'lab-wrist-roi-meta', filePath: metaPaths['wrist-roi'] },
  ];
  if (!nasArchive.enabled) return { state: 'disabled', archiveJobId, error: 'NAS archive is not configured' };
  const recordPath = path.join(workspace, 'nas-archive.json');
  const writeStatus = (archive) => {
    const record = { archiveJobId, sourceJobId: jobId, archive, updatedAt: new Date().toISOString() };
    const temporary = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(temporary, recordPath);
  };
  const scheduled = nasArchive.schedule({
    jobId: archiveJobId,
    status: 'done',
    shot: null,
    cache: null,
    artifacts,
    manifest: {
      archiveKind: 'club_preprocess_lab',
      lab: {
        sourceJobId: jobId,
        sourceVideoFilename: path.basename(sourceVideoPath || inputPath),
        inputVideoFilename: path.basename(inputPath),
        decision: labResult.report?.decision || null,
        labVersion: labResult.report?.lab || null,
      },
    },
    onStatus: writeStatus,
  });
  if (scheduled) writeStatus({ state: 'pending', attempt: 0, error: null });
  return { state: scheduled ? 'pending' : 'not_scheduled', archiveJobId, recordPath };
}

function swingTrackingArchiveRecordPath(jobId) {
  return path.join(swingTrackingArchiveDir, `${jobId}.json`);
}

function writeSwingTrackingArchiveStatus(jobId, archiveJobId, archive) {
  const recordPath = swingTrackingArchiveRecordPath(jobId);
  const record = {
    archiveJobId,
    sourceJobId: jobId,
    archive,
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(temporary, recordPath);
  return record;
}

function queueSwingTrackingAnnotationArchive(jobId, annotationPath, annotation) {
  const archiveJobId = `annotation-${jobId}`;
  if (!nasArchive.enabled) {
    return {
      state: 'disabled',
      archiveJobId,
      error: 'NAS archive is not configured',
    };
  }
  const scheduled = nasArchive.schedule({
    jobId: archiveJobId,
    status: 'done',
    shot: null,
    cache: null,
    artifacts: [{ artifact: 'annotation', filePath: annotationPath }],
    manifest: {
      archiveKind: 'swing_tracking_annotation',
      swingTracking: {
        sourceJobId: jobId,
        schemaVersion: annotation?.schemaVersion || null,
        status: annotation?.status || null,
        updatedAt: annotation?.updatedAt || null,
      },
    },
    onStatus: (archive) => writeSwingTrackingArchiveStatus(jobId, archiveJobId, archive),
  });
  if (scheduled) {
    writeSwingTrackingArchiveStatus(jobId, archiveJobId, {
      state: 'pending',
      attempt: 0,
      retryAt: null,
      error: null,
    });
  }
  return {
    state: scheduled ? 'pending' : 'not_scheduled',
    archiveJobId,
    recordPath: swingTrackingArchiveRecordPath(jobId),
  };
}

function queueSwingTrackingDatasetArchive(version) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(version)) {
    throw new Error('Invalid dataset version');
  }
  const datasetRoot = path.join(dataDir, 'datasets', version);
  const zipPath = path.join(dataDir, 'datasets', `${version}.zip`);
  if (!fs.existsSync(datasetRoot) || !fs.existsSync(zipPath)) {
    throw new Error('Dataset export or ZIP is missing');
  }
  const archiveJobId = `dataset-${version}`;
  const recordPath = path.join(dataDir, 'datasets', `${version}.archive.json`);
  const writeStatus = (archive) => {
    const record = { archiveJobId, datasetVersion: version, archive, updatedAt: new Date().toISOString() };
    const temporary = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(temporary, recordPath);
  };
  if (!nasArchive.enabled) return { state: 'disabled', archiveJobId, error: 'NAS archive is not configured' };
  const scheduled = nasArchive.schedule({
    jobId: archiveJobId,
    status: 'done',
    shot: null,
    cache: null,
    artifacts: [
      { artifact: 'dataset-zip', filePath: zipPath },
      { artifact: 'dataset-manifest', filePath: path.join(datasetRoot, 'dataset_manifest.json') },
      { artifact: 'event-training-manifest', filePath: path.join(datasetRoot, 'event_training_manifest.json') },
      { artifact: 'split-manifest', filePath: path.join(datasetRoot, 'split_manifest.json') },
      { artifact: 'data-config', filePath: path.join(datasetRoot, 'data.yaml') },
    ],
    manifest: { archiveKind: 'swing_tracking_dataset', datasetVersion: version },
    onStatus: writeStatus,
  });
  if (scheduled) writeStatus({ state: 'pending', attempt: 0, retryAt: null, error: null });
  return { state: scheduled ? 'pending' : 'not_scheduled', archiveJobId, recordPath };
}

function resumeNasArchiveQueue() {
  if (!nasArchive.enabled) return;
  let entries = [];
  try {
    entries = fs.readdirSync(analysisCacheDir, { withFileTypes: true });
  } catch (error) {
    console.warn(`[nas-archive] unable to read cache directory: ${error.message}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const jobId = path.basename(entry.name, '.json');
    const cache = readAnalysisCache(jobId);
    if (!cache || !['done', 'failed'].includes(cache.status) || isNasArchiveComplete(cache.nasArchive)) continue;
    queueNasArchive(cache);
  }
}

let analysisReconcileInProgress = false;
async function reconcileAnalysisQueue() {
  if (analysisReconcileInProgress) return;
  analysisReconcileInProgress = true;
  try {
    const entries = fs.readdirSync(analysisCacheDir, { withFileTypes: true });
    const pendingJobIds = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.basename(entry.name, '.json'))
      .filter((jobId) => {
        const cache = readAnalysisCache(jobId);
        return cache && ['queued', 'pending', 'running'].includes(cache.status);
      });

    for (const jobId of pendingJobIds) {
      // fetchInferJobPayload is the canonical result normalizer. When infer has
      // finished it writes the terminal cache and writeAnalysisCache schedules
      // the NAS archive, independent of any browser polling this endpoint.
      await fetchInferJobPayload(jobId, { includeResult: false });
    }
  } catch (error) {
    console.warn(`[analysis-reconcile] unable to reconcile queued jobs: ${error.message}`);
  } finally {
    analysisReconcileInProgress = false;
  }
}

function readNasDeletionCursor() {
  try {
    return JSON.parse(fs.readFileSync(nasDeletionCursorPath, 'utf8')).cursor || '';
  } catch {
    return '';
  }
}

function writeNasDeletionCursor(cursor) {
  fs.writeFileSync(nasDeletionCursorPath, JSON.stringify({ cursor, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

async function applyNasDeletion(jobId) {
  if (!isSafeJobId(jobId)) return;
  const shot = shotStore.getShotByJobId(jobId);
  const cache = readAnalysisCache(jobId);
  if (shot?.media?.filename) await removeIfPresent(resolveUploadPath(shot.media.filename));
  await removeJobArtifacts(jobId, cache);
  if (shot?.media?.filename) shotStore.removeShotByFilename(shot.media.filename);
}

let nasDeletionSyncInProgress = false;
async function syncNasDeletions() {
  if (!nasArchive.enabled || nasDeletionSyncInProgress) return;
  nasDeletionSyncInProgress = true;
  try {
    const cursor = readNasDeletionCursor();
    const result = await nasArchive.listDeletions(cursor);
    for (const deletion of result.deletions || []) {
      await applyNasDeletion(deletion.jobId);
      await nasArchive.acknowledgeDeletion(deletion.jobId);
    }
    if (result.cursor && result.cursor !== cursor) writeNasDeletionCursor(result.cursor);
  } catch (error) {
    console.warn(`[nas-archive] deletion sync failed: ${error.message}`);
  } finally {
    nasDeletionSyncInProgress = false;
  }
}

function mapInferStatus(status) {
  const v = String(status || '').toLowerCase();
  if (v === 'queued' || v === 'pending') return 'pending';
  if (v === 'running' || v === 'processing') return 'running';
  if (v === 'succeeded' || v === 'success' || v === 'done' || v === 'completed') return 'done';
  if (v === 'failed' || v === 'error') return 'failed';
  return 'pending';
}

function mapCacheStatusToFileStatus(status) {
  if (status === 'pending' || status === 'queued') return 'queued';
  if (status === 'running') return 'running';
  if (status === 'done') return 'succeeded';
  if (status === 'failed') return 'failed';
  return 'not-analyzed';
}

function buildJobAnalysisPayloadFromAnalysis(jobId, status, analysis) {
  const mappedStatus = status === 'done' ? 'succeeded' : status === 'failed' ? 'failed' : 'running';
  return buildJobAnalysisPayload({ jobId, status: mappedStatus, analysis });
}

function buildCoachAnalysisPayload(jobId, status, result) {
  const tempo = result?.metrics?.tempo || {};
  const metrics = result?.metrics || {};
  const asMetricPayload = (value, extra = {}) => {
    if (!value || value === null) return null;
    if (typeof value === 'string') return { label: value, ...extra };
    if (typeof value === 'object') return { ...value, ...extra };
    if (typeof value === 'number') return { label: String(value), ...extra };
    return null;
  };
  const impactMs =
    result?.events?.impactMs ??
    result?.events?.impact?.timeMs ??
    result?.events?.impact?.time_ms ??
    null;
  const eventValue = (key) =>
    result?.events?.[`${key}Ms`] ??
    result?.events?.[key]?.timeMs ??
    result?.events?.[key]?.time_ms ??
    result?.metrics?.eventTiming?.[key] ??
    null;
  const eventObject = (key) => {
    const value = eventValue(key);
    return value !== null && value !== undefined ? { timeMs: value } : null;
  };
  const ratioValue =
    tempo.ratio === null || tempo.ratio === undefined
      ? null
      : typeof tempo.ratio === 'string'
        ? tempo.ratio
        : `${tempo.ratio}:1`;
  const mappedStatus = status === 'done' ? 'succeeded' : status === 'failed' ? 'failed' : 'running';
  const groupedClubMetrics = metrics.club ?? metrics.clubMetrics ?? {
    swingPlane: asMetricPayload(metrics.swingPlaneDetail ?? metrics.swingPlane),
    impactStability: asMetricPayload(metrics.impactStabilityDetail ?? metrics.impactStability),
    shaftPlane: asMetricPayload(metrics.shaftPlane),
    backswing: asMetricPayload(metrics.backswing),
    readiness: asMetricPayload(metrics.readiness),
    trackingQuality: asMetricPayload(metrics.trackingQuality),
  };
  const groupedFusionMetrics = metrics.fusion ?? metrics.fusionMetrics ?? {
    tempo: asMetricPayload(metrics.tempo, {
      label: ratioValue ? `tempo ${ratioValue}` : null,
      comment: result?.summary ?? null,
    }),
    ball: asMetricPayload(metrics.ball, {
      label: metrics?.ball?.launchDirection || 'unknown',
    }),
  };
  return {
    jobId,
    status: mappedStatus,
    analysisVersion: result?.analysisVersion || 'coach-meta-v1',
    errorCode: result?.errorCode ?? null,
    events: {
      address: eventObject('address'),
      takeaway: eventObject('takeaway'),
      top: eventObject('top'),
      impact: eventObject('impact') || (impactMs !== null ? { timeMs: impactMs } : null),
      finish: eventObject('finish'),
    },
    metrics: {
      tempo: {
        backswingMs: tempo.backswingMs ?? tempo.backswing_time_ms ?? null,
        downswingMs: tempo.downswingMs ?? tempo.downswing_time_ms ?? null,
        ratio: ratioValue,
      },
      eventTiming: {
        address: eventValue('address'),
        takeaway: eventValue('takeaway'),
        top: eventValue('top'),
        impact: eventValue('impact'),
        finish: eventValue('finish'),
      },
      ball: metrics.ball || {
        launchDirection: 'unknown',
        launchAngle: null,
        speedRelative: 'unknown',
      },
      swingPlane: metrics.swingPlane ?? null,
      impactStability: metrics.impactStability ?? null,
      shaftPlane: metrics.shaftPlane ?? null,
      backswing: metrics.backswing ?? null,
      readiness: metrics.readiness ?? null,
      trackingQuality: metrics.trackingQuality ?? null,
      body: metrics.body ?? metrics.bodyMetrics ?? null,
      club: groupedClubMetrics,
      fusion: groupedFusionMetrics,
    },
    pending: DEFAULT_PENDING_ITEMS,
    errorMessage: result?.errorMessage ?? null,
    summary: result?.summary ?? null,
    coachSummary: result?.coachSummary ?? result?.coach_summary ?? [],
    coachFindings: result?.coachFindings ?? result?.coach_findings ?? result?.debug?.coachFindings ?? [],
    confidence: result?.confidence ?? null,
    analysisQuality: result?.analysisQuality ?? null,
    eventValidation: result?.eventValidation ?? null,
    overlay: result?.overlay ?? null,
    meta: result?.meta ?? null,
    progress: result?.progress ?? null,
  };
}

function isJobAnalysisPayload(result) {
  return Boolean(result?.metrics?.ball) && Boolean(result?.events);
}

function hasUsableInferMetrics(result) {
  if (!result || typeof result !== 'object') return false;
  const metrics = result.metrics;
  if (!metrics || typeof metrics !== 'object') return false;
  const events = result.events;
  const hasEvent =
    events &&
    typeof events === 'object' &&
    ['address', 'takeaway', 'top', 'impact', 'finish', 'addressMs', 'takeawayMs', 'topMs', 'impactMs', 'finishMs'].some(
      (key) => events[key] !== null && events[key] !== undefined,
    );
  const eventsWithheldForQuality = result.eventValidation?.status === 'withheld';
  return Boolean(
    (hasEvent || eventsWithheldForQuality) &&
      (metrics.tempo ||
        metrics.swingPlane ||
        metrics.impactStability ||
        metrics.shaftPlane ||
        metrics.backswing ||
        metrics.trackingQuality),
  );
}

function mapInferResultStatus(result, fallbackStatus) {
  const rawStatus = String(result?.status || '').toLowerCase();
  if (result?.errorCode || result?.ok === false || rawStatus === 'failed' || rawStatus === 'error') return 'failed';
  if (!hasUsableInferMetrics(result) && (rawStatus === 'done' || rawStatus === 'succeeded' || rawStatus === 'success')) {
    return 'failed';
  }
  if (result?.ok === true && (rawStatus === 'done' || rawStatus === 'succeeded' || rawStatus === 'success')) {
    return 'succeeded';
  }
  if (rawStatus === 'done' || rawStatus === 'succeeded' || rawStatus === 'success') return 'succeeded';
  if (rawStatus === 'failed' || rawStatus === 'error') return 'failed';
  if (rawStatus === 'running' || rawStatus === 'queued' || rawStatus === 'pending') return 'running';
  if (fallbackStatus === 'done') return 'succeeded';
  if (fallbackStatus === 'failed') return 'failed';
  if (fallbackStatus === 'running') return 'running';
  return rawStatus || 'running';
}

function normalizeInferResult(jobId, status, result) {
  if (!result || typeof result !== 'object') {
    return buildInferErrorAnalysis(jobId, 'infer result payload missing');
  }
  if (result.analysis && typeof result.analysis === 'object') {
    return normalizeInferResult(jobId, status, result.analysis);
  }
  if (!hasUsableInferMetrics(result)) {
    const rawStatus = String(result.status || '').toLowerCase();
    const errorMessage =
      result.errorMessage ||
      result.error ||
      (rawStatus === 'running' || rawStatus === 'queued' || rawStatus === 'pending'
        ? 'infer result not ready'
        : 'infer result missing metrics/events');
    return {
      ...buildInferErrorAnalysis(jobId, errorMessage),
      errorCode: result.errorCode || (rawStatus === 'running' || rawStatus === 'queued' || rawStatus === 'pending' ? 'INFER_RESULT_NOT_READY' : 'INFER_RESULT_EMPTY'),
    };
  }
  if (isJobAnalysisPayload(result)) {
    const mappedStatus = mapInferResultStatus(result, status);
    return {
      ok: result.ok !== false,
      jobId: result.jobId || jobId,
      status: mappedStatus || 'running',
      analysisVersion: result.analysisVersion || result.analysis_version || 'coach-meta-v1',
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
      events: result.events || {},
      metrics: result.metrics || null,
      summary: result.summary ?? null,
      coachSummary: result.coachSummary ?? result.coach_summary ?? [],
      coachFindings: result.coachFindings ?? result.coach_findings ?? result.debug?.coachFindings ?? [],
      confidence: result.confidence ?? null,
      analysisQuality: result.analysisQuality ?? null,
      eventValidation: result.eventValidation ?? null,
      overlay: result.overlay ?? null,
      meta: result.meta ?? null,
      debug: result.debug ?? null,
      pending: result.pending || DEFAULT_PENDING_ITEMS,
      progress: result.progress ?? null,
    };
  }
  if (result.swing || result.ballFlight || result.impact) {
    return buildJobAnalysisPayloadFromAnalysis(jobId, status, result);
  }
  if (result.metrics && result.events) {
    return buildCoachAnalysisPayload(jobId, status, result);
  }
  return buildCoachAnalysisPayload(jobId, status, result);
}

function inferAnalysisVersion(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;
  return analysis.analysisVersion || analysis.analysis_version || analysis.meta?.analysisVersion || analysis.meta?.analysis_version || null;
}

function hasFreshInferAnalysis(cached) {
  if (!cached || typeof cached !== 'object') return false;
  return inferAnalysisVersion(cached.analysis) === expectedInferAnalysisVersion;
}

function buildInferErrorAnalysis(jobId, errorMessage) {
  return {
    jobId,
    status: 'failed',
    analysisVersion: 'coach-meta-v1',
    errorCode: 'INFER_UNAVAILABLE',
    events: {
      address: null,
      takeaway: null,
      top: null,
      impact: null,
      finish: null,
    },
    metrics: {
      tempo: { backswingMs: null, downswingMs: null, ratio: null },
      eventTiming: { address: null, takeaway: null, top: null, impact: null, finish: null },
      ball: { launchDirection: 'unknown', launchAngle: null, speedRelative: 'unknown' },
    },
    pending: DEFAULT_PENDING_ITEMS,
    errorMessage,
    meta: null,
  };
}

function inferUrl(pathname) {
  if (!inferBaseUrl) return null;
  const base = inferBaseUrl.replace(/\/$/, '');
  return `${base}${pathname}`;
}

function cameraUrl(pathname) {
  if (!cameraBaseUrl) return null;
  const base = cameraBaseUrl.replace(/\/$/, '');
  return `${base}${pathname}`;
}

function bodyUrl(pathname) {
  if (!bodyAnalyzerBaseUrl) return null;
  const base = bodyAnalyzerBaseUrl.replace(/\/$/, '');
  return `${base}${pathname}`;
}

async function inferFetchJson(url, { method = 'GET', body, timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      json,
      textSnippet: typeof text === 'string' ? text.slice(0, 400) : '',
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error,
      durationMs: Date.now() - startedAt,
      textSnippet: '',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitInferJobVisibility(
  jobId,
  { attempts = 8, intervalMs = 1000, timeoutMs = 1500 } = {},
) {
  const statusUrl = inferUrl(`/v1/jobs/${encodeURIComponent(jobId)}`);
  if (!statusUrl) {
    return {
      visible: false,
      errorMessage: 'infer service not configured',
      lastStatus: 0,
    };
  }

  let lastStatus = 0;
  let lastErrorMessage = null;
  let attemptsUsed = 0;
  let lastDurationMs = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const statusRes = await inferFetchJson(statusUrl, { timeoutMs });
    attemptsUsed = attempt + 1;
    lastStatus = statusRes.status;
    lastDurationMs = statusRes.durationMs || 0;
    if (statusRes.ok) {
      return {
        visible: true,
        status: mapInferStatus(statusRes.json?.status || statusRes.json?.state),
        payload: statusRes.json,
        lastStatus,
        attemptsUsed,
        lastDurationMs,
      };
    }

    lastErrorMessage =
      statusRes.json?.message ||
      statusRes.json?.error ||
      statusRes.error?.message ||
      lastErrorMessage;

    if (attempt < attempts - 1) {
      await sleep(intervalMs);
    }
  }

  return {
    visible: false,
    errorMessage: lastErrorMessage || 'infer job did not become visible in time',
    lastStatus,
    attemptsUsed,
    lastDurationMs,
  };
}

async function submitInferJobAndWait(jobId, requestBody, submitTimeoutMs = 10_000) {
  const baseUrl = inferUrl('/v1/jobs');
  if (!baseUrl) {
    return {
      accepted: false,
      errorMessage: 'infer service not configured',
      submitStatus: 0,
    };
  }

  const response = await inferFetchJson(baseUrl, {
    method: 'POST',
    body: requestBody,
    timeoutMs: submitTimeoutMs,
  });

  if (response.ok || response.status === 409) {
    if (response.status === 409) {
      const visibility = await awaitInferJobVisibility(jobId, {
        attempts: 3,
        intervalMs: 500,
        timeoutMs: 1500,
      });
      return {
        accepted: true,
        status: visibility.visible ? visibility.status : 'running',
        submitStatus: response.status,
        submitDurationMs: response.durationMs || 0,
        responseBodySnippet: response.textSnippet || null,
        visibility,
      };
    }

    return {
      accepted: true,
      status: 'pending',
      submitStatus: response.status,
      submitDurationMs: response.durationMs || 0,
      responseBodySnippet: response.textSnippet || null,
    };
  }

  const visibility = await awaitInferJobVisibility(jobId, {
    attempts: 8,
    intervalMs: 1000,
    timeoutMs: 1500,
  });

  if (visibility.visible) {
    return {
      accepted: true,
      status: visibility.status,
      submitStatus: response.status,
      submitDurationMs: response.durationMs || 0,
      responseBodySnippet: response.textSnippet || null,
      visibility,
      recoveredAfterSubmitFailure: true,
    };
  }

  return {
    accepted: false,
    errorMessage:
      response.json?.message ||
      response.json?.error ||
      response.error?.message ||
      visibility.errorMessage ||
      'infer service unavailable',
    submitStatus: response.status,
    submitDurationMs: response.durationMs || 0,
    responseBodySnippet: response.textSnippet || null,
    visibility,
  };
}

async function requestUploadMetaGeneration({
  jobId,
  filename,
  inputPath,
  force,
  durationSec,
  videoMeta,
}) {
  const url = cameraUrl('/api/meta/from-file');
  if (!url || !jobId || !filename || !inputPath) return null;
  const response = await inferFetchJson(url, {
    method: 'POST',
    body: {
      jobId,
      filename,
      inputPath,
      model: 'yolov8n_service7',
      force: Boolean(force),
      durationSec,
      durationMs: videoMeta?.durationMs,
      width: videoMeta?.width,
      height: videoMeta?.height,
      fps: videoMeta?.fps,
    },
    timeoutMs: 120_000,
  });
  if (!response.ok) return null;
  const metaPath = response.json?.metaPath;
  return typeof metaPath === 'string' ? metaPath : null;
}

async function requestDtlClubPointsV2MetaGeneration({
  jobId,
  metadataJobId,
  filename,
  inputPath,
  durationSec,
  videoMeta,
}) {
  const url = cameraUrl('/api/meta/from-file');
  if (!url || !jobId || !filename || !inputPath) return null;
  const response = await inferFetchJson(url, {
    method: 'POST',
    body: {
      jobId: metadataJobId || `${jobId}-dtl-v2`,
      filename,
      inputPath,
      model: 'dtl_club_points_v2',
      force: true,
      durationSec,
      durationMs: videoMeta?.durationMs,
      width: videoMeta?.width,
      height: videoMeta?.height,
      fps: videoMeta?.fps,
    },
    timeoutMs: 180_000,
  });
  return response.ok && typeof response.json?.metaPath === 'string'
    ? { metaPath: response.json.metaPath, durationMs: response.durationMs || 0 }
    : null;
}

async function requestDtlClubPointsV2SidecarAnalysis({ jobId, metaPath, bodyPath, impactMs }) {
  const url = inferUrl('/v1/club-sidecar/from-meta');
  if (!url || !metaPath) return null;
  const response = await inferFetchJson(url, {
    method: 'POST',
    body: { jobId, metaPath, bodyPath: bodyPath || null, allowBodyFallback: false, takeawayProfile: DTL_V2_TAKEAWAY_PROFILE, impactMs },
    timeoutMs: 30_000,
  });
  if (!response.ok && response.json?.detail?.jobId === jobId && response.json?.detail?.errorCode === 'BODY_UNAVAILABLE') {
    const error = new Error('The requested body artifact is missing or unreadable');
    error.code = 'BODY_UNAVAILABLE';
    throw error;
  }
  return response.ok && response.json?.ok === true && response.json?.jobId === jobId
    && response.json?.bodyFallbackAllowed === false && response.json?.result?.jobId === jobId
    ? response.json.result
    : null;
}

let dtlClubPointsV2Tail = Promise.resolve();
const activeDtlClubPointsV2 = new Map();

function summarizeDtlClubPointsV2(result, metaPath, durationMs) {
  const tracking = result?.metrics?.trackingQuality || null;
  const eventValidation = result?.eventValidation || null;
  const takeawayMs = result?.events?.takeawayMs;
  const takeawayStatus = eventValidation?.eventQuality?.takeaway?.status || 'withheld';
  return {
    status: result?.ok === true && result?.status === 'done' ? 'succeeded' : 'failed',
    model: 'dtl_club_points_v2',
    takeawayProfile: DTL_V2_TAKEAWAY_PROFILE,
    metaPath,
    processingMs: durationMs,
    events: result?.events || null,
    trackingQuality: tracking,
    observations: result?.clubObservations || null,
    overlay: result?.overlay?.clubTimeSource === 'video_pts'
      ? { ...result.overlay, poseFrames: [] } : null,
    eventValidation,
    takeaway: {
      timeMs: Number.isFinite(takeawayMs) ? takeawayMs : null,
      status: takeawayStatus,
      appliedToPrimary: false,
    },
    completedAt: new Date().toISOString(),
  };
}

// V2 queue transitions are transient operational state. Archive only the
// completed sidecar below, not every queued/running update in a batch.
function updateDtlClubPointsV2Cache(jobId, sidecar) {
  const cache = readAnalysisCache(jobId);
  if (!cache) return null;
  return writeAnalysisCache(jobId, { ...cache, dtlClubPointsV2: sidecar }, { scheduleArchive: false });
}

function updateDtlClubRefresh(jobId, refreshId, patch) {
  const cache = readAnalysisCache(jobId);
  if (!cache || cache.dtlClubRefresh?.id !== refreshId) return null;
  return writeAnalysisCache(jobId, {
    ...cache, dtlClubRefresh: { ...cache.dtlClubRefresh, ...patch },
  }, { scheduleArchive: false });
}

function isStaleDtlClubPointsV2Run(sidecar, nowMs = Date.now()) {
  if (sidecar?.status !== 'running' || typeof sidecar.startedAt !== 'string') return false;
  const startedAtMs = Date.parse(sidecar.startedAt);
  return Number.isFinite(startedAtMs) && nowMs - startedAtMs > DTL_V2_STALE_RUNNING_MS;
}

function scheduleDtlClubPointsV2Sidecar(jobId, { force = false, refresh = false } = {}) {
  if (activeDtlClubPointsV2.has(jobId)) {
    const runningId = activeDtlClubPointsV2.get(jobId);
    return { scheduled: false, reason: 'already scheduled', ...(refresh && runningId ? { refreshId: runningId } : {}) };
  }
  const cache = readAnalysisCache(jobId);
  if (!cache || cache.status !== 'done') return { scheduled: false, reason: 'primary analysis unavailable' };
  const current = cache.dtlClubPointsV2;
  const staleRunning = isStaleDtlClubPointsV2Run(current);
  // Explicit refresh upgrades legacy sidecars once; live/current work is reused.
  if (
    (current?.status === 'succeeded' && !refresh && (!force || current.observations?.revision === 1))
    || (current?.status === 'queued' && !force)
    || (current?.status === 'running' && !(force && staleRunning))
  ) {
    return { scheduled: false, reason: current?.status || 'already scheduled' };
  }

  const refreshId = refresh ? randomUUID() : null;
  const debugSidecar = cache.analysis?.debug?.dtlClubPointsV2 || null;
  const baselineSidecar = refresh ? JSON.stringify([current || null, debugSidecar]) : null;
  if (refresh) {
    writeAnalysisCache(jobId, { ...cache, dtlClubRefresh: { id: refreshId, status: 'queued', queuedAt: new Date().toISOString() } }, { scheduleArchive: false });
  } else {
    updateDtlClubPointsV2Cache(jobId, {
      status: 'queued', model: 'dtl_club_points_v2', queuedAt: new Date().toISOString(),
    });
  }
  const updateRun = (patch) => refresh
    ? updateDtlClubRefresh(jobId, refreshId, patch)
    : updateDtlClubPointsV2Cache(jobId, patch);
  activeDtlClubPointsV2.set(jobId, refreshId);
  const run = dtlClubPointsV2Tail.then(async () => {
    const latest = readAnalysisCache(jobId);
    const shot = shotStore.getShotByJobId(jobId);
    if (refresh && (latest?.status !== 'done' || latest.dtlClubRefresh?.id !== refreshId
      || JSON.stringify([latest.dtlClubPointsV2 || null, latest.analysis?.debug?.dtlClubPointsV2 || null]) !== baselineSidecar)) {
      updateRun({ status: 'failed', error: 'Saved analysis changed before club refresh' });
      return;
    }
    if (shot?.metadata?.viewpoint === 'face_on' || shot?.metadata?.handedness === 'left') {
      updateRun({ status: 'failed', error: 'right-handed DTL input required' });
      return;
    }
    const shotInputPath = shot?.metadata?.analysisInput?.path || shot?.media?.path;
    let inputPath = shotInputPath;
    const bodyPath = latest?.progress?.bodyPath || shot?.metadata?.bodyPath || bodyArtifactPath(jobId);
    if (!inputPath || !fs.existsSync(inputPath)) {
      updateRun({ status: 'failed', error: 'analysis input unavailable' });
      return;
    }
    const sourceIdentity = fs.statSync(shotInputPath);
    // Upload analysis normally leaves a converted MP4 in analysisInput. Legacy
    // re-analysis may only have the original MOV, while camera file inference
    // deliberately accepts MP4/H264/JPEG inputs. Reuse the same preparation
    // path rather than weakening the camera's input allowlist.
    if (path.extname(inputPath).toLowerCase() === '.mov') {
      const prepared = await prepareVideoForAnalysis(inputPath, shot?.media?.filename || path.basename(inputPath));
      if (!prepared.ok || !prepared.path) {
        updateRun({ status: 'failed', error: 'DTL V2 video preparation failed' });
        return;
      }
      inputPath = prepared.path;
    }
    const videoIdentity = fs.statSync(inputPath);
    const hasBody = fs.existsSync(bodyPath);
    const bodyIdentity = hasBody ? fs.statSync(bodyPath) : null;
    updateRun({
      status: 'running', model: 'dtl_club_points_v2', startedAt: new Date().toISOString(),
    });
    const videoMeta = await getVideoMeta(inputPath);
    const generated = await requestDtlClubPointsV2MetaGeneration({
      jobId,
      metadataJobId: refresh ? `club-refresh-${refreshId}` : undefined,
      filename: shot?.media?.filename || path.basename(inputPath),
      inputPath,
      durationSec: Number.isFinite(videoMeta?.durationMs) ? videoMeta.durationMs / 1000 : undefined,
      videoMeta,
    });
    if (!generated) {
      updateRun({ status: 'failed', error: 'DTL V2 meta generation failed' });
      return;
    }
    let metaIdentity = null;
    try {
      const resolvedMeta = resolveMetaPath(generated.metaPath, jobId);
      const stat = resolvedMeta && fs.lstatSync(resolvedMeta);
      if (stat?.isFile()) metaIdentity = stat;
    } catch { /* An unverified timeline remains usable only with a warning. */ }
    let impact = null;
    try {
      impact = await scheduleAutomaticImpact(jobId, inputPath, hasBody ? bodyPath : null);
      if (!Number.isFinite(impact?.candidate?.timeMs)) throw new Error('Invalid impact candidate');
    }
    catch (error) {
      impact = null;
      console.warn(`[dtl-v2-sidecar] ${jobId} impact unavailable: ${error.message}`);
      if (refresh && [current, debugSidecar].some(value => value?.observations?.levels?.some(level => level?.status === 'observation'))) {
        throw new Error('Impact candidate unavailable; previous club comparison preserved');
      }
    }
    const result = await requestDtlClubPointsV2SidecarAnalysis({ jobId, metaPath: generated.metaPath, bodyPath: hasBody ? bodyPath : null, impactMs: impact?.candidate?.timeMs });
    if (!result) {
      updateRun({
        status: 'failed', metaPath: generated.metaPath, error: 'DTL V2 sidecar analysis failed',
      });
      return;
    }
    const sidecar = summarizeDtlClubPointsV2(result, generated.metaPath, generated.durationMs);
    const coverage = await verifyClubSourceCoverage({ jobId, metaPath: generated.metaPath, metaIdentity,
      inputPath, videoIdentity, overlay: sidecar.overlay, impact });
    sidecar.sourceFrameCoverage = { status: coverage.status,
      ...(coverage.status === 'verified' ? { missingFrames: coverage.missingFrames } : {}) };
    if (coverage.status === 'verified') {
      sidecar.overlayVideoSha256 = impact.videoSha256;
      sidecar.pendingOverlay = coverage.overlay;
      sidecar.overlay = null;
    }
    if (!impact) {
      sidecar.overlayVideoSha256 = await hashVideoFile(inputPath);
      sidecar.pendingOverlay = sidecar.overlay;
      sidecar.overlay = null;
      sidecar.observations = { status: 'withheld', revision: 1, automaticCoachingReady: false,
        reason: 'IMPACT_CANDIDATE_UNAVAILABLE', levels: [] };
    }
    if (metaIdentity) {
      const metaPath = resolveMetaPath(generated.metaPath, jobId);
      if (!metaPath || !matchesVideoIdentity(metaIdentity, fs.lstatSync(metaPath))) {
        throw new Error('Club metadata changed during analysis');
      }
    }
    const updated = readAnalysisCache(jobId);
    const updatedShot = shotStore.getShotByJobId(jobId);
    const updatedInputPath = updatedShot?.metadata?.analysisInput?.path || updatedShot?.media?.path;
    const updatedBodyPath = updated?.progress?.bodyPath || updatedShot?.metadata?.bodyPath || bodyArtifactPath(jobId);
    if (!updated || updated.status !== 'done' || (refresh && updated.dtlClubRefresh?.id !== refreshId)
      || !updatedInputPath || path.resolve(updatedInputPath) !== path.resolve(shotInputPath)
      || !updatedBodyPath || path.resolve(updatedBodyPath) !== path.resolve(bodyPath)
      || updatedShot?.metadata?.viewpoint !== shot?.metadata?.viewpoint
      || updatedShot?.metadata?.handedness !== shot?.metadata?.handedness
      || !matchesVideoIdentity(sourceIdentity, fs.statSync(shotInputPath))
      || (refresh && JSON.stringify([updated.dtlClubPointsV2 || null, updated.analysis?.debug?.dtlClubPointsV2 || null]) !== baselineSidecar)
      || !matchesVideoIdentity(videoIdentity, fs.statSync(inputPath))
      || fs.existsSync(bodyPath) !== hasBody
      || (bodyIdentity && !matchesVideoIdentity(bodyIdentity, fs.statSync(bodyPath)))
      || sidecar.status !== 'succeeded') {
      throw new Error('Saved input or analysis changed during club analysis');
    }
    const analysis = updated?.analysis && typeof updated.analysis === 'object' ? { ...updated.analysis } : null;
    const takeawayMs = sidecar.takeaway.timeMs;
    const primaryTakeaway = analysis?.events?.takeaway ?? analysis?.events?.takeawayMs;
    if (!refresh && impact && analysis && primaryTakeaway == null && Number.isFinite(takeawayMs)
      && ['confirmed', 'reference'].includes(sidecar.takeaway.status)) {
      analysis.events = Object.prototype.hasOwnProperty.call(analysis.events || {}, 'takeawayMs')
        ? { ...analysis.events, takeawayMs }
        : { ...analysis.events, takeaway: { timeMs: takeawayMs } };
      analysis.metrics = {
        ...analysis.metrics,
        eventTiming: { ...(analysis.metrics?.eventTiming || {}), takeaway: takeawayMs },
      };
      sidecar.takeaway.appliedToPrimary = true;
    }
    if (analysis) {
      analysis.debug = { ...(analysis.debug || {}), dtlClubPointsV2: sidecar };
    }
    const saveIdentity = (file, stat) => ({ path: path.resolve(file), ...Object.fromEntries(
      ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]),
    ) });
    const persisted = writeAnalysisCache(jobId, {
      ...updated,
      analysis,
      dtlClubPointsV2: sidecar,
      ...(refresh ? {
        dtlClubPointsV2BeforeRefresh: updated.dtlClubPointsV2BeforeRefresh || current || debugSidecar || null,
        ...(current && debugSidecar && JSON.stringify(current) !== JSON.stringify(debugSidecar) && !updated.dtlClubPointsV2DebugBeforeRefresh
          ? { dtlClubPointsV2DebugBeforeRefresh: debugSidecar } : {}),
        dtlClubRefresh: { ...updated.dtlClubRefresh, status: 'succeeded', completedAt: new Date().toISOString() },
        dtlClubRefreshSource: {
          metaPath: sidecar.metaPath, completedAt: sidecar.completedAt,
          source: saveIdentity(shotInputPath, sourceIdentity), input: saveIdentity(inputPath, videoIdentity),
          body: hasBody ? saveIdentity(bodyPath, bodyIdentity) : { path: path.resolve(bodyPath), absent: true },
          viewpoint: shot?.metadata?.viewpoint ?? null, handedness: shot?.metadata?.handedness ?? null,
        },
      } : {}),
    }, { scheduleArchive: false });
    if (!persisted && refresh) throw new Error('Could not save club refresh');
    if (persisted) {
      if (!refresh) queueNasArchive(persisted, { force: true });
      else {
        try { queueNasArchive(persisted, { force: true }); }
        catch (error) {
          console.warn(`[nas-archive] ${jobId} could not queue refreshed analysis: ${error.message}`);
          try { updateNasArchiveStatus(jobId, { state: 'failed', error: 'Could not queue refreshed analysis', retryAt: null }); }
          catch (statusError) { console.warn(`[nas-archive] ${jobId} could not record failure: ${statusError.message}`); }
        }
      }
    }
  });
  dtlClubPointsV2Tail = run.catch((error) => {
    console.warn(`[dtl-v2-sidecar] ${jobId} failed: ${error.message}`);
    updateRun({ status: 'failed', error: error.message, ...(error.code === 'BODY_UNAVAILABLE' ? { errorCode: error.code } : {}) });
  }).finally(() => activeDtlClubPointsV2.delete(jobId));
  return { scheduled: true, reason: 'queued', ...(refresh ? { refreshId } : {}) };
}

function eventTimeMs(events, key) {
  if (!events || typeof events !== 'object') return null;
  const direct = events[`${key}Ms`];
  if (Number.isFinite(direct)) return direct;
  const nested = events[key];
  return nested && typeof nested === 'object' && Number.isFinite(nested.timeMs) ? nested.timeMs : null;
}

function emptyEventScore() {
  return { samples: 0, totalAbsoluteErrorMs: 0, within100Ms: 0 };
}

function finalizeEventScore(score) {
  return {
    samples: score.samples,
    maeMs: score.samples ? Math.round(score.totalAbsoluteErrorMs / score.samples) : null,
    within100MsRate: score.samples ? Number((score.within100Ms / score.samples).toFixed(3)) : null,
  };
}

async function buildDtlClubPointsV2EventBenchmark() {
  const annotations = await swingTrackingAnnotations.list();
  const scores = Object.fromEntries(SWING_EVENT_KEYS.map((key) => [key, {
    primary: emptyEventScore(),
    v2: emptyEventScore(),
  }]));
  let primaryJobs = 0;
  let v2Jobs = 0;
  let reviewedJobs = 0;
  let inScopeJobs = 0;

  for (const item of annotations) {
    const annotation = await swingTrackingAnnotations.load(item.jobId);
    if (!annotation || annotation.status !== 'reviewed') continue;
    reviewedJobs += 1;
    if (annotation.viewpoint !== 'down_the_line' || annotation.handedness !== 'right') continue;
    inScopeJobs += 1;
    const cache = readAnalysisCache(item.jobId);
    if (!cache) continue;
    const primaryEvents = cache.analysis?.events;
    const v2 = cache.dtlClubPointsV2 || cache.analysis?.debug?.dtlClubPointsV2;
    const v2Events = v2?.status === 'succeeded' ? v2.events : null;
    let primarySeen = false;
    let v2Seen = false;
    for (const key of SWING_EVENT_KEYS) {
      const label = annotation.events?.[key];
      const labeled = label?.timeMs;
      if (label?.source !== 'manual' || !Number.isFinite(labeled)) continue;
      const primaryTime = eventTimeMs(primaryEvents, key);
      const v2Time = eventTimeMs(v2Events, key);
      if (!Number.isFinite(primaryTime) || !Number.isFinite(v2Time)) continue;
      for (const [name, predicted] of [['primary', primaryTime], ['v2', v2Time]]) {
        const score = scores[key][name];
        const errorMs = Math.abs(predicted - labeled);
        score.samples += 1;
        score.totalAbsoluteErrorMs += errorMs;
        if (errorMs <= 100) score.within100Ms += 1;
        if (name === 'primary') primarySeen = true;
        else v2Seen = true;
      }
    }
    if (primarySeen) primaryJobs += 1;
    if (v2Seen) v2Jobs += 1;
  }

  const events = Object.fromEntries(SWING_EVENT_KEYS.map((key) => {
    const primary = finalizeEventScore(scores[key].primary);
    const v2 = finalizeEventScore(scores[key].v2);
    return [key, {
      primary,
      v2,
      v2ImprovesMae: primary.samples ? scores[key].v2.totalAbsoluteErrorMs < scores[key].primary.totalAbsoluteErrorMs : null,
      v2ImprovesWithin100Ms: primary.samples
        ? scores[key].v2.within100Ms > scores[key].primary.within100Ms
        : null,
    }];
  }));
  return {
    annotationJobs: annotations.length, reviewedJobs, inScopeJobs, primaryJobs, v2Jobs, events,
    referencePolicy: 'reviewed_manual_paired', independentValidation: false,
  };
}

async function requestBodyAnalysis({
  jobId,
  filename,
  inputPath,
  force,
  videoMeta,
}) {
  const url = bodyUrl('/v1/body/from-video');
  if (!url || !jobId || !filename || !inputPath) {
    return { ok: false, skipped: true, reason: 'body analyzer not configured' };
  }

  const response = await inferFetchJson(url, {
    method: 'POST',
    body: {
      jobId,
      filename,
      inputPath,
      force: Boolean(force),
      videoMeta: videoMeta || null,
    },
    timeoutMs: 60000,
  });

  const fallbackBodyPath = bodyArtifactPath(jobId);
  const fallbackBodyExists =
    typeof fallbackBodyPath === 'string' && fs.existsSync(fallbackBodyPath);

  if (!response.ok) {
    if (fallbackBodyExists) {
      return {
        ok: true,
        bodyPath: fallbackBodyPath,
        metrics: response.json?.metrics || null,
        status: response.status,
        textSnippet: response.textSnippet || null,
        recoveredFromDisk: true,
      };
    }
    return {
      ok: false,
      skipped: false,
      reason:
        response.json?.detail?.errorMessage ||
        response.json?.detail?.message ||
        response.json?.detail?.error ||
        response.json?.message ||
        response.json?.error ||
        (response.error?.name === 'AbortError' ? 'body analyzer request timed out' : null) ||
        response.error?.message ||
        'body analyzer request failed',
      status: response.status,
      textSnippet: response.textSnippet || null,
    };
  }

  return {
    ok: true,
    bodyPath: response.json?.bodyPath || response.json?.path || (fallbackBodyExists ? fallbackBodyPath : null),
    metrics: response.json?.metrics || null,
    status: response.status,
    textSnippet: response.textSnippet || null,
    recoveredFromDisk: !response.json?.bodyPath && !response.json?.path && fallbackBodyExists,
  };
}

function buildQueuedUploadShot(file, body, freshJobId = false) {
  const existing = shotStore.getShotByMediaName(file.filename);
  const retainedMetadata = freshJobId ? { ...existing?.metadata } : {};
  delete retainedMetadata.metaPath;
  delete retainedMetadata.bodyPath;
  delete retainedMetadata.analysisInput;
  const sourceType = body.sourceType || existing?.sourceType || 'upload';
  const jobId = freshJobId ? randomUUID() : existing?.jobId || randomUUID();
  const shotId = existing?.id || randomUUID();
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
  const metadata = {
    ...retainedMetadata,
    club: body.club,
    viewpoint: ['down_the_line', 'face_on'].includes(body.viewpoint) ? body.viewpoint : 'unknown',
    handedness: ['right', 'left'].includes(body.handedness) ? body.handedness : 'unknown',
    fps: toNumberOrUndefined(body.fps),
    cameraConfig: body.cameraConfig,
    roi: body.roi,
    cam_distance: toNumberOrUndefined(body.cam_distance),
    cam_height: toNumberOrUndefined(body.cam_height),
    h_fov: toNumberOrUndefined(body.h_fov),
    v_fov: toNumberOrUndefined(body.v_fov),
    impact_frame: toNumberOrUndefined(body.impact_frame),
    track_frames: toNumberOrUndefined(body.track_frames),
    sourceType,
  };
  const queuedShot = {
    id: shotId,
    jobId,
    status: 'queued',
    sessionId,
    sourceType,
    createdAt: existing?.createdAt || new Date().toISOString(),
    media: {
      ...existing?.media,
      filename: file.filename,
      path: file.path,
      size: file.size,
    },
    metadata: {
      ...metadata,
      metaPath: resolveMetaPath(body.metaPath, jobId) || undefined,
    },
    analysis: freshJobId ? null : existing?.analysis ?? null,
  };
  shotStore.upsertShot(queuedShot);
  return queuedShot;
}

function markQueuedUploadShotFailed(file, errorMessage) {
  const existing = shotStore.getShotByMediaName(file.filename);
  if (!existing) return;
  const progress = buildAnalysisProgress('failed', {
    analysisPath: existing?.progress?.analysisPath || 'unknown',
    metaPath: existing?.metadata?.metaPath || null,
    message: errorMessage || PROGRESS_STAGE_META.failed.message,
  });
  shotStore.upsertShot({
    ...existing,
    status: 'failed',
    progress,
    analysis: {
      analysisVersion: existing.analysis?.analysisVersion || opencvAnalyzer.ANALYSIS_VERSION,
      errorCode: 'UPLOAD_ANALYSIS_FAILED',
      errorMessage,
      events: existing.analysis?.events || {},
      swing: null,
      ballFlight: null,
      shot_type: 'unknown',
      coach_summary: [`analysis failed: ${errorMessage}`],
      analysis_id: randomUUID(),
    },
  });
  mergeAnalysisCache(existing.jobId, {
    status: 'failed',
    errorCode: 'UPLOAD_ANALYSIS_FAILED',
    errorMessage,
    progress,
  });
}

const activeUploadJobs = new Set();

function queueUploadedShotAnalysis(file, body, freshJobId = false) {
  const queuedShot = buildQueuedUploadShot(file, body, freshJobId);
  activeUploadJobs.add(queuedShot.jobId);
  setImmediate(() => {
    analyzeAndStoreUploadedShot(file, body, freshJobId ? queuedShot.jobId : null)
      .catch((err) => {
        console.error('queued upload analysis failed', err);
        try {
          markQueuedUploadShotFailed(file, err.message || 'Analysis failed');
        } catch (storeError) {
          console.error('could not persist failed upload status', storeError);
        }
      })
      .finally(() => activeUploadJobs.delete(queuedShot.jobId));
  });
  return queuedShot;
}

async function analyzeAndStoreUploadedShot(file, body, retryJobId = null) {
  const existing = shotStore.getShotByMediaName(file.filename);
  const sourceType = body.sourceType || existing?.sourceType || 'upload';
  const force = toBoolean(body.force);
  const shotId = existing?.id || randomUUID();
  const jobId = existing?.jobId || randomUUID();
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
  const meta = {
    ...existing?.metadata,
    club: body.club,
    viewpoint: body.viewpoint || existing?.metadata?.viewpoint || 'unknown',
    handedness: body.handedness || existing?.metadata?.handedness || 'unknown',
    fps: toNumberOrUndefined(body.fps),
    cameraConfig: body.cameraConfig,
    roi: body.roi,
    cam_distance: toNumberOrUndefined(body.cam_distance),
    cam_height: toNumberOrUndefined(body.cam_height),
    h_fov: toNumberOrUndefined(body.h_fov),
    v_fov: toNumberOrUndefined(body.v_fov),
    impact_frame: toNumberOrUndefined(body.impact_frame),
    track_frames: toNumberOrUndefined(body.track_frames),
    sourceType,
  };
  delete meta.metaPath;
  delete meta.bodyPath;
  delete meta.analysisInput;
  const explicitMetaPath =
    typeof body.metaPath === 'string' && body.metaPath.trim().length > 0
      ? resolveMetaPath(body.metaPath, jobId)
      : null;
  let effectiveMetaPath = explicitMetaPath;
  let effectiveBodyPath =
    typeof body.bodyPath === 'string' && body.bodyPath.trim().length > 0 ? body.bodyPath.trim() : null;
  let progress = buildAnalysisProgress('upload_received', { metaPath: effectiveMetaPath });
  const createPendingShot = (patch = {}) => {
    const shot = {
      id: shotId,
      jobId,
      status: 'queued',
      sessionId,
      sourceType,
      createdAt: existing?.createdAt || new Date().toISOString(),
      media: {
        ...existing?.media,
        filename: file.filename,
        path: file.path,
        size: file.size,
      },
      metadata: { ...meta, metaPath: effectiveMetaPath || undefined, bodyPath: effectiveBodyPath || undefined, ...patch.metadata },
      analysis: patch.analysis ?? existing?.analysis ?? null,
      progress: patch.progress || progress,
    };
    shotStore.upsertShot(shot);
    return shot;
  };
  const updateProgress = (stage, patch = {}) => {
    const mergedPatch = {
      metaPath: effectiveMetaPath,
      bodyPath: effectiveBodyPath,
      ...patch,
    };
    if (mergedPatch.analysisPath === 'infer' && !mergedPatch.clubPath && effectiveMetaPath) {
      mergedPatch.clubPath = effectiveMetaPath;
    }
    const groupedStage =
      ['pose_running', 'pose_ready', 'club_running', 'club_ready', 'fusion_running', 'fusion_succeeded'].includes(stage) ||
      Boolean(mergedPatch.bodyPath || mergedPatch.clubPath || mergedPatch.fusionPath);
    progress = groupedStage ? buildGroupedProgress(stage, mergedPatch) : buildAnalysisProgress(stage, mergedPatch);
    return progress;
  };
  const mergeProgressDetail = (detail = {}) => ({
    ...(progress?.detail && typeof progress.detail === 'object' ? progress.detail : {}),
    ...(detail && typeof detail === 'object' ? detail : {}),
  });

  createPendingShot();

  if (explicitMetaPath) {
    queueAutomaticImpactWithAvailableBody(jobId, file.path, meta);
    progress = buildGroupedProgress('club_ready', {
      analysisPath: 'infer',
      metaPath: effectiveMetaPath,
      bodyPath: effectiveBodyPath,
      detail: mergeProgressDetail({ source: 'provided-meta' }),
    });
    createPendingShot();
    const metaReady = await waitForFile(effectiveMetaPath, 2000);
    if (metaReady) {
      progress = buildGroupedProgress('fusion_running', {
        analysisPath: 'infer',
        metaPath: effectiveMetaPath,
        bodyPath: effectiveBodyPath,
        detail: mergeProgressDetail({ source: 'provided-meta' }),
      });
      mergeAnalysisCache(jobId, {
        status: 'pending',
        analysis: null,
        errorCode: null,
        errorMessage: null,
        metaPath: effectiveMetaPath,
        progress,
      });
      const requestBody = {
        mode: 'coach_from_meta',
        jobId,
        source: {
          filename: file.filename,
          videoPath: file.path,
          metaPath: effectiveMetaPath,
          bodyPath: effectiveBodyPath,
        },
        options: {
          force: Boolean(force),
          ...(body.club ? { club: body.club } : {}),
          ...(['down_the_line', 'face_on'].includes(body.viewpoint) ? { viewpoint: body.viewpoint } : {}),
          ...(['right', 'left'].includes(body.handedness) ? { handedness: body.handedness } : {}),
        },
      };
      const submitResult = await submitInferJobAndWait(jobId, requestBody);
      if (submitResult.accepted) {
        progress = buildGroupedProgress(submitResult.status === 'done' ? 'fusion_succeeded' : 'fusion_running', {
          analysisPath: 'infer',
          metaPath: effectiveMetaPath,
          bodyPath: effectiveBodyPath,
          clubPath: effectiveMetaPath,
          fusionPath: submitResult.status === 'done' ? inferAnalysisPath(jobId) : null,
          detail: {
            submitStatus: submitResult.submitStatus,
            submitDurationMs: submitResult.submitDurationMs || 0,
            responseBodySnippet: submitResult.responseBodySnippet || null,
            recoveredAfterSubmitFailure: submitResult.recoveredAfterSubmitFailure === true,
            visibilityStatus: submitResult.visibility?.lastStatus ?? 0,
            visibilityAttempts: submitResult.visibility?.attemptsUsed ?? 0,
          },
        });
        mergeAnalysisCache(jobId, {
          status:
            submitResult.status === 'done'
              ? 'done'
              : submitResult.status === 'running'
              ? 'running'
              : 'pending',
          analysis: null,
          errorCode: null,
          errorMessage: null,
          metaPath: effectiveMetaPath,
          progress,
        });
        return createPendingShot();
      }
      updateProgress('failed', {
        analysisPath: 'infer',
        metaPath: effectiveMetaPath,
        detail: {
          reason: submitResult.errorMessage || 'infer submit failed',
          submitStatus: submitResult.submitStatus,
          submitDurationMs: submitResult.submitDurationMs || 0,
          responseBodySnippet: submitResult.responseBodySnippet || null,
          visibilityStatus: submitResult.visibility?.lastStatus ?? 0,
          visibilityAttempts: submitResult.visibility?.attemptsUsed ?? 0,
        },
      });
    }
  }

  updateProgress('video_preparing');
  createPendingShot();
  const prepared = await prepareVideoForAnalysis(file.path, file.filename, retryJobId);
  if (prepared.ok === false) {
    updateProgress('failed', {
      analysisPath: 'opencv',
      message: `영상 디코딩/변환에 실패했습니다. (${prepared.error})`,
    });
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
      id: shotId,
      jobId,
      status: 'failed',
      sessionId,
      sourceType,
      createdAt: existing?.createdAt || new Date().toISOString(),
      media: {
        ...existing?.media,
        filename: file.filename,
        path: file.path,
        size: file.size,
      },
      metadata: { ...meta, metaPath: effectiveMetaPath || undefined },
      analysis,
      progress,
    };
    shotStore.upsertShot(shot);
    mergeAnalysisCache(jobId, {
      status: 'failed',
      analysis: buildJobAnalysisPayload(shot),
      errorCode: analysis.errorCode,
      errorMessage: analysis.errorMessage,
      metaPath: effectiveMetaPath,
      progress,
    });
    return shot;
  }

  updateProgress('video_ready');
  meta.analysisInput = {
    path: prepared.path, converted: Boolean(prepared.converted),
    conversion: prepared.conversion, warning: prepared.warning,
  };
  createPendingShot();

  const preparedVideoMeta = await getVideoMeta(prepared.path);

  progress = buildGroupedProgress('pose_running', {
    analysisPath: 'pending',
    metaPath: effectiveMetaPath,
    bodyPath: effectiveBodyPath,
    detail: mergeProgressDetail({ source: 'body:/v1/body/from-video' }),
  });
  createPendingShot();
  const bodyResult = await requestBodyAnalysis({
    jobId,
    filename: file.filename,
    inputPath: prepared.path,
    force,
    videoMeta: preparedVideoMeta,
  });
  if (bodyResult.ok) {
    effectiveBodyPath = bodyResult.bodyPath || effectiveBodyPath;
    progress = buildGroupedProgress('pose_ready', {
      analysisPath: 'pending',
      metaPath: effectiveMetaPath,
      bodyPath: effectiveBodyPath,
      detail: mergeProgressDetail({
        source: 'body:/v1/body/from-video',
        bodyStatus: bodyResult.status || 200,
      }),
    });
    createPendingShot();
  } else {
    progress = buildGroupedProgress('video_ready', {
      analysisPath: 'pending',
      metaPath: effectiveMetaPath,
      bodyPath: effectiveBodyPath,
      detail: mergeProgressDetail({
        source: 'body:/v1/body/from-video',
        bodySkipped: bodyResult.skipped === true,
        bodyReason: bodyResult.reason || null,
        bodyStatus: bodyResult.status || 0,
        bodyResponseSnippet: bodyResult.textSnippet || null,
      }),
    });
    createPendingShot();
  }

  queueAutomaticImpact(jobId, prepared.path, bodyResult.ok ? effectiveBodyPath : null);

  if (!explicitMetaPath) {
    progress = buildGroupedProgress('club_running', {
      analysisPath: 'infer',
      metaPath: effectiveMetaPath,
      bodyPath: effectiveBodyPath,
      detail: mergeProgressDetail({ source: 'camera:/api/meta/from-file' }),
    });
    createPendingShot();
    const generatedMetaPath = await requestUploadMetaGeneration({
      jobId,
      filename: file.filename,
      inputPath: prepared.path,
      force,
      durationSec:
        Number.isFinite(preparedVideoMeta?.durationMs) && preparedVideoMeta.durationMs > 0
          ? preparedVideoMeta.durationMs / 1000
          : undefined,
      videoMeta: preparedVideoMeta,
    });
    if (generatedMetaPath) {
      effectiveMetaPath = resolveMetaPath(generatedMetaPath, jobId);
      progress = buildGroupedProgress('club_ready', {
        analysisPath: 'infer',
        metaPath: effectiveMetaPath,
        bodyPath: effectiveBodyPath,
        clubPath: effectiveMetaPath,
        detail: mergeProgressDetail({
          source: 'camera:/api/meta/from-file',
          generatedMetaPath: effectiveMetaPath,
        }),
      });
      createPendingShot();
    } else {
      updateProgress('failed', {
        analysisPath: 'infer',
        message: '카메라 서버가 업로드 영상용 service7 메타를 생성하지 못했습니다.',
        detail: {
          source: 'camera:/api/meta/from-file',
          generatedMetaPath: null,
        },
      });
    }
  }

  if (effectiveMetaPath) {
    const metaReady = await waitForFile(effectiveMetaPath, 2000);
    if (metaReady) {
      progress = buildGroupedProgress('fusion_running', {
        analysisPath: 'infer',
        metaPath: effectiveMetaPath,
        bodyPath: effectiveBodyPath,
        clubPath: effectiveMetaPath,
        detail: mergeProgressDetail({
          metaReady: true,
        }),
      });
      mergeAnalysisCache(jobId, {
        status: 'pending',
        analysis: null,
        errorCode: null,
        errorMessage: null,
        metaPath: effectiveMetaPath,
        progress,
      });
      const requestBody = {
        mode: 'coach_from_meta',
        jobId,
        source: {
          filename: file.filename,
          videoPath: prepared.path,
          metaPath: effectiveMetaPath,
          bodyPath: effectiveBodyPath,
        },
        options: { force: Boolean(force) },
      };
      const submitResult = await submitInferJobAndWait(jobId, requestBody);
      if (submitResult.accepted) {
        progress = buildGroupedProgress(submitResult.status === 'done' ? 'fusion_succeeded' : 'fusion_running', {
          analysisPath: 'infer',
          metaPath: effectiveMetaPath,
          bodyPath: effectiveBodyPath,
          clubPath: effectiveMetaPath,
          fusionPath: submitResult.status === 'done' ? inferAnalysisPath(jobId) : null,
          detail: mergeProgressDetail({
            submitStatus: submitResult.submitStatus,
            submitDurationMs: submitResult.submitDurationMs || 0,
            responseBodySnippet: submitResult.responseBodySnippet || null,
            recoveredAfterSubmitFailure: submitResult.recoveredAfterSubmitFailure === true,
            visibilityStatus: submitResult.visibility?.lastStatus ?? 0,
            visibilityAttempts: submitResult.visibility?.attemptsUsed ?? 0,
          }),
        });
        mergeAnalysisCache(jobId, {
          status:
            submitResult.status === 'done'
              ? 'done'
              : submitResult.status === 'running'
              ? 'running'
              : 'pending',
          analysis: null,
          errorCode: null,
          errorMessage: null,
          metaPath: effectiveMetaPath,
          progress,
        });
        return createPendingShot();
      }
      updateProgress('failed', {
        analysisPath: 'infer',
        metaPath: effectiveMetaPath,
        detail: {
          reason: submitResult.errorMessage || 'infer submit failed',
          submitStatus: submitResult.submitStatus,
          submitDurationMs: submitResult.submitDurationMs || 0,
          responseBodySnippet: submitResult.responseBodySnippet || null,
          visibilityStatus: submitResult.visibility?.lastStatus ?? 0,
          visibilityAttempts: submitResult.visibility?.attemptsUsed ?? 0,
        },
      });
    }
  }

  const inferFailureReason = !effectiveMetaPath
    ? 'service7 meta path was not created for upload analysis'
    : 'service7 infer job could not be submitted';
  const inferFailureMessage =
    '업로드 분석이 service7 추론 단계에 도달하지 못했습니다. OpenCV fallback은 현재 비활성화되어 있습니다.';
  const previousDetail = progress?.detail && typeof progress.detail === 'object' ? progress.detail : {};
  updateProgress('failed', {
    analysisPath: effectiveMetaPath ? 'infer' : 'pending',
    metaPath: effectiveMetaPath,
    message: inferFailureMessage,
    detail: {
      ...previousDetail,
      reason: inferFailureReason,
      converted: Boolean(prepared.converted),
      conversion: prepared.conversion || null,
      warning: prepared.warning || null,
    },
  });

  const analysis = buildInferErrorAnalysis(jobId, inferFailureMessage);
  analysis.errorCode = 'INFER_PIPELINE_UNREACHED';
  analysis.analysisVersion = 'infer-only';
  analysis.progress = progress;
  analysis.meta = {
    converted: Boolean(prepared.converted),
    conversion: prepared.conversion || null,
    warning: prepared.warning || null,
  };

  const shot = {
    id: shotId,
    jobId,
    status: 'failed',
    sessionId,
    sourceType,
    createdAt: existing?.createdAt || new Date().toISOString(),
    media: {
      ...existing?.media,
      filename: file.filename,
      path: file.path,
      size: file.size,
    },
    metadata: {
      ...meta,
      metaPath: effectiveMetaPath || undefined,
      analysisInput: {
        path: prepared.path,
        converted: Boolean(prepared.converted),
        conversion: prepared.conversion,
        warning: prepared.warning,
      },
    },
    analysis,
    progress,
  };

  shotStore.upsertShot(shot);
  mergeAnalysisCache(jobId, {
    status: 'failed',
    analysis: buildJobAnalysisPayload(shot),
    errorCode: analysis.errorCode,
    errorMessage: analysis.errorMessage,
    metaPath: effectiveMetaPath,
    progress,
  });
  return shot;
}

// Analyze uploaded video and store shot result
const analyzeUploadHandler = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, message: 'No file uploaded' });
  }

  try {
    const shot = queueUploadedShotAnalysis(req.file, {
      ...(req.body || {}),
      force: toBoolean(req.body?.force) || toBoolean(req.query?.force),
    });
    res.json({ ok: true, shot });
  } catch (err) {
    console.error('analyze/upload failed', err);
    res.status(500).json({
      ok: false,
      message: err.message || 'Analysis failed',
      errorMessage: err.message || 'Analysis failed',
      errorCode: err.code === 'SHOT_STORE_UNAVAILABLE' ? err.code : undefined,
    });
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
    const shot = queueUploadedShotAnalysis(req.file, {
      ...(req.body || {}),
      force: toBoolean(req.body?.force) || toBoolean(req.query?.force),
    });
    return res.json({
      ok: true,
      jobId: shot.jobId,
      filename: req.file.filename,
      url: uploadsUrl(req.file.filename),
      status: shot.status,
      progress: shot.progress || null,
    });
  } catch (err) {
    console.error('analyze job failed', err);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Analysis failed',
      errorMessage: err.message || 'Analysis failed',
      errorCode: err.code === 'SHOT_STORE_UNAVAILABLE' ? err.code : undefined,
    });
  }
});

// Analyze an already stored upload without creating another copy of the video.
app.post('/api/analyze/existing-upload', (req, res) => {
  const filename = req.body?.filename;
  if (typeof filename !== 'string' || path.basename(filename) !== filename || filename.includes('\\') || filename.includes('\0')
      || Buffer.byteLength(filename) > 255 || !isSupportedVideoExt(filename)) {
    return res.status(400).json({ ok: false, message: '영상 파일 이름을 확인해 주세요.' });
  }
  const inputPath = resolveUploadPath(filename);
  if (!inputPath) return res.status(400).json({ ok: false, message: '영상 파일 이름을 확인해 주세요.' });
  const options = req.body?.options ?? {};
  if (typeof options !== 'object' || Array.isArray(options)
      || (options.club != null && (typeof options.club !== 'string' || options.club.length > 80))
      || (options.viewpoint != null && !['down_the_line', 'face_on', 'unknown'].includes(options.viewpoint))
      || (options.handedness != null && !['right', 'left', 'unknown'].includes(options.handedness))
      || (options.force != null && typeof options.force !== 'boolean')) {
    return res.status(400).json({ ok: false, message: '분석 설정을 확인해 주세요.' });
  }
  try {
    let stat;
    try { stat = fs.lstatSync(inputPath); }
    catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ ok: false, message: '저장된 영상을 찾을 수 없습니다.' });
      throw error;
    }
    if (!stat.isFile() || stat.size === 0) return res.status(400).json({ ok: false, message: '저장된 영상을 읽을 수 없습니다.' });
    const matchingShots = shotStore.listShots().filter((shot) => shot.media?.filename === filename);
    if (matchingShots.length > 1) {
      return res.status(409).json({ ok: false, message: '같은 영상에 연결된 기록이 여러 개여서 재분석을 보류했습니다.' });
    }
    const previous = matchingShots[0];
    if (previous?.sourceType === 'camera' || previous?.metadata?.sourceType === 'camera') {
      return res.status(409).json({ ok: false, message: '카메라 영상은 카메라 기록에서 분석해 주세요.' });
    }
    if (previous?.jobId && activeUploadJobs.has(previous.jobId)) {
      return res.json({ ok: true, jobId: previous.jobId, filename, status: 'queued' });
    }
    const oldJobId = previous?.jobId || path.basename(filename, path.extname(filename));
    if (!isSafeJobId(oldJobId) || oldJobId.includes('\0')) return res.status(409).json({ ok: false, message: '기존 기록의 식별 정보를 확인해 주세요.' });
    const cache = readAnalysisCache(oldJobId);
    const cacheStatus = ['pending', 'queued', 'running', 'done', 'failed'].includes(cache?.status)
      ? mapCacheStatusToFileStatus(cache.status) : normalizeJobStatus(cache?.status);
    const status = cacheStatus || normalizeJobStatus(previous?.status);
    if (status === 'succeeded') return res.status(409).json({ ok: false, message: '이미 분석된 영상입니다. 기록에서 결과를 확인해 주세요.' });
    if (status === 'queued' || status === 'running') return res.status(409).json({ ok: false, message: '이 영상의 분석이 진행 중입니다. 잠시 후 다시 확인해 주세요.' });
    try {
      fs.lstatSync(path.join(swingTrackingAnnotations.annotationDir, `${oldJobId}.json`));
      return res.status(409).json({ ok: false, message: '기존 라벨과 영상의 연결을 보존하기 위해 이 영상의 재분석을 보류했습니다.' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (previous) {
      const backupDir = path.join(dataDir, 'shot-retry-snapshots');
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, `${randomUUID()}.json`), JSON.stringify(previous), { flag: 'wx', mode: 0o600 });
    }
    const priorMeta = previous?.metadata || {};
    const shot = queueUploadedShotAnalysis({ filename, path: inputPath, size: stat.size }, {
      club: options.club ?? priorMeta.club,
      viewpoint: options.viewpoint ?? priorMeta.viewpoint,
      handedness: options.handedness ?? priorMeta.handedness,
      fps: priorMeta.fps ?? undefined, cameraConfig: priorMeta.cameraConfig, roi: priorMeta.roi,
      cam_distance: priorMeta.cam_distance ?? undefined, cam_height: priorMeta.cam_height ?? undefined,
      h_fov: priorMeta.h_fov ?? undefined, v_fov: priorMeta.v_fov ?? undefined,
      impact_frame: priorMeta.impact_frame ?? undefined, track_frames: priorMeta.track_frames ?? undefined,
      force: options.force === true,
    }, true);
    return res.json({ ok: true, jobId: shot.jobId, filename, status: shot.status });
  } catch (error) {
    console.error('existing upload analysis failed', error);
    return res.status(500).json({
      ok: false,
      message: error.code === 'SHOT_STORE_UNAVAILABLE' ? error.message : '저장된 영상의 분석을 시작하지 못했습니다. 기록과 서버 상태를 확인해 주세요.',
      errorCode: error.code === 'SHOT_STORE_UNAVAILABLE' ? error.code : undefined,
    });
  }
});

// Trigger analysis for an existing file in UPLOAD_DIR (no re-upload)
app.post('/api/analyze/from-file', async (req, res) => {
  const payload = req.body || {};
  const source = payload.source && typeof payload.source === 'object' ? payload.source : {};
  const providedJobId = typeof payload.jobId === 'string' ? payload.jobId : null;
  const filename =
    typeof payload.filename === 'string'
      ? payload.filename
      : typeof source.filename === 'string'
        ? source.filename
        : null;
  const metaPathInput =
    typeof payload.metaPath === 'string'
      ? payload.metaPath
      : typeof source.metaPath === 'string'
        ? source.metaPath
        : null;
  const force =
    payload.force === true ||
    toBoolean(payload.force) ||
    payload.options?.force === true ||
    toBoolean(payload.options?.force);
  const requireVideo =
    payload.requireVideo === true ||
    toBoolean(payload.requireVideo) ||
    source.requireVideo === true ||
    toBoolean(source.requireVideo);
  const club =
    typeof payload.options?.club === 'string' && payload.options.club.trim()
      ? payload.options.club.trim()
      : null;
  const viewpoint = ['down_the_line', 'face_on'].includes(payload.options?.viewpoint)
    ? payload.options.viewpoint
    : 'unknown';
  const handedness = ['right', 'left'].includes(payload.options?.handedness)
    ? payload.options.handedness
    : 'unknown';
  if (!providedJobId) {
    return res.status(400).json({ ok: false, message: 'jobId is required' });
  }
  if (providedJobId.includes('/') || providedJobId.includes('\\')) {
    return res.status(400).json({ ok: false, message: 'Invalid jobId' });
  }

  const targetFilename = filename || `${providedJobId}.mp4`;
  if (!isSupportedVideoExt(targetFilename)) {
    return res.status(400).json({ ok: false, message: 'Only .mp4/.mov is supported' });
  }
  const resolvedVideoPath = resolveUploadPath(targetFilename);
  if (!resolvedVideoPath) {
    return res.status(400).json({ ok: false, message: 'Invalid file path' });
  }
  const resolvedMetaPath = resolveMetaPath(metaPathInput, providedJobId);
  if (!resolvedMetaPath) {
    return res.status(400).json({ ok: false, message: 'Invalid meta path' });
  }
  const linkedShot = shotStore.getShotByMediaName(targetFilename);
  if (linkedShot?.jobId && linkedShot.jobId !== providedJobId) {
    return res.status(409).json({ ok: false, message: '영상에 연결된 기존 분석 기록이 달라 요청을 보류했습니다.' });
  }
  let progress = buildGroupedProgress('club_ready', {
    analysisPath: 'infer',
    metaPath: resolvedMetaPath,
    clubPath: resolvedMetaPath,
  });

  if (requireVideo) {
    const videoStat = await fs.promises.stat(resolvedVideoPath).catch(() => null);
    if (!videoStat?.isFile() || videoStat.size <= 0) {
      const errorCode = videoStat ? 'VIDEO_EMPTY' : 'VIDEO_MISSING';
      const errorMessage = videoStat
        ? `video file is empty: ${resolvedVideoPath}`
        : `video file not found: ${resolvedVideoPath}`;
      const analysis = {
        ...buildInferErrorAnalysis(providedJobId, errorMessage),
        errorCode,
      };
      progress = buildAnalysisProgress('failed', {
        analysisPath: 'infer',
        metaPath: resolvedMetaPath,
        message: errorMessage,
      });
      writeAnalysisCache(providedJobId, {
        status: 'failed',
        analysis,
        errorCode,
        errorMessage,
        metaPath: resolvedMetaPath,
        progress,
      });
      return res.json({
        ok: true,
        jobId: providedJobId,
        filename: targetFilename,
        status: 'failed',
        errorCode,
        errorMessage,
        progress,
      });
    }
  }

  registerFileImpact(providedJobId, targetFilename, resolvedVideoPath, { viewpoint, handedness });
  const cached = readAnalysisCache(providedJobId);
  const cachedAgeMs = cached?.updatedAt ? Date.now() - Date.parse(cached.updatedAt) : Number.POSITIVE_INFINITY;
  const hasFreshInFlightCache =
    Number.isFinite(cachedAgeMs) &&
    cachedAgeMs < 30_000 &&
    (cached.status === 'pending' || cached.status === 'running');
  if (!force && cached?.status && ((cached.status === 'done' && hasFreshInferAnalysis(cached)) || hasFreshInFlightCache)) {
    return res.json({
      ok: true,
      jobId: providedJobId,
      filename: targetFilename,
      status: cached.status,
      progress: cached.progress || progress,
    });
  }

  const metaReady = await waitForFile(resolvedMetaPath, 2000);
  if (!metaReady) {
    const errorMessage = `meta file not found: ${resolvedMetaPath}`;
    const analysis = buildInferErrorAnalysis(providedJobId, errorMessage);
    progress = buildAnalysisProgress('failed', {
      analysisPath: 'infer',
      metaPath: resolvedMetaPath,
      message: errorMessage,
    });
    writeAnalysisCache(providedJobId, {
      status: 'failed',
      analysis,
      errorCode: analysis.errorCode,
      errorMessage,
      metaPath: resolvedMetaPath,
      progress,
    });
    return res.json({
      ok: true,
      jobId: providedJobId,
      filename: targetFilename,
      status: 'failed',
      errorCode: analysis.errorCode,
      errorMessage,
      progress,
    });
  }

  const baseUrl = inferUrl('/v1/jobs');
  if (!baseUrl) {
    const errorMessage = 'infer service not configured';
    const analysis = buildInferErrorAnalysis(providedJobId, errorMessage);
    progress = buildAnalysisProgress('failed', {
      analysisPath: 'infer',
      metaPath: resolvedMetaPath,
      message: errorMessage,
    });
    writeAnalysisCache(providedJobId, {
      status: 'failed',
      analysis,
      errorCode: analysis.errorCode,
      errorMessage,
      metaPath: resolvedMetaPath,
      progress,
    });
    return res.json({
      ok: true,
      jobId: providedJobId,
      status: 'failed',
      errorCode: analysis.errorCode,
      errorMessage,
      progress,
    });
  }

  const videoPath = resolvedVideoPath;
  const requestBody = {
    mode: 'coach_from_meta',
    jobId: providedJobId,
    source: {
      filename: targetFilename,
      videoPath,
      metaPath: resolvedMetaPath,
      bodyPath: bodyArtifactPath(providedJobId),
    },
    options: {
      force: Boolean(force),
      ...(club ? { club } : {}),
      ...(viewpoint !== 'unknown' ? { viewpoint } : {}),
      ...(handedness !== 'unknown' ? { handedness } : {}),
    },
  };

  progress = buildGroupedProgress('fusion_running', {
    analysisPath: 'infer',
    metaPath: resolvedMetaPath,
    clubPath: resolvedMetaPath,
  });
  mergeAnalysisCache(providedJobId, {
    status: 'pending',
    analysis: cached?.analysis || null,
    errorCode: null,
    errorMessage: null,
    metaPath: resolvedMetaPath,
    progress,
  });
  const submitResult = await submitInferJobAndWait(providedJobId, requestBody);
  if (!submitResult.accepted) {
    const errorMessage = submitResult.errorMessage || 'infer service unavailable';
    const analysis = buildInferErrorAnalysis(providedJobId, errorMessage);
    progress = buildGroupedProgress('failed', {
      analysisPath: 'infer',
      metaPath: resolvedMetaPath,
      message: errorMessage,
      detail: {
        submitStatus: submitResult.submitStatus,
        submitDurationMs: submitResult.submitDurationMs || 0,
        responseBodySnippet: submitResult.responseBodySnippet || null,
        visibilityStatus: submitResult.visibility?.lastStatus ?? 0,
        visibilityAttempts: submitResult.visibility?.attemptsUsed ?? 0,
      },
    });
    writeAnalysisCache(providedJobId, {
      status: 'failed',
      analysis,
      errorCode: analysis.errorCode,
      errorMessage,
      metaPath: resolvedMetaPath,
      progress,
    });
    return res.json({
      ok: true,
      jobId: providedJobId,
      status: 'failed',
      errorCode: analysis.errorCode,
      errorMessage,
      progress,
    });
  }

  progress = buildGroupedProgress(submitResult.status === 'done' ? 'fusion_succeeded' : 'fusion_running', {
    analysisPath: 'infer',
    metaPath: resolvedMetaPath,
    clubPath: resolvedMetaPath,
    fusionPath: submitResult.status === 'done' ? inferAnalysisPath(providedJobId) : null,
    detail: {
      submitStatus: submitResult.submitStatus,
      submitDurationMs: submitResult.submitDurationMs || 0,
      responseBodySnippet: submitResult.responseBodySnippet || null,
      recoveredAfterSubmitFailure: submitResult.recoveredAfterSubmitFailure === true,
      visibilityStatus: submitResult.visibility?.lastStatus ?? 0,
      visibilityAttempts: submitResult.visibility?.attemptsUsed ?? 0,
    },
  });
  writeAnalysisCache(providedJobId, {
    status:
      submitResult.status === 'done'
        ? 'done'
        : submitResult.status === 'running'
        ? 'running'
        : 'pending',
    analysis: null,
    errorCode: null,
    errorMessage: null,
    metaPath: resolvedMetaPath,
    progress,
  });
  return res.json({
    ok: true,
    jobId: providedJobId,
    status:
      submitResult.status === 'done'
        ? 'done'
        : submitResult.status === 'running'
        ? 'running'
        : 'queued',
    progress,
  });
});

async function fetchInferJobPayload(jobId, { includeResult } = {}) {
  const cached = readAnalysisCache(jobId);
  // Completed reads must not reset sidecar/archive state or schedule work again.
  if (cached?.status === 'done' && hasFreshInferAnalysis(cached) && hasUsableInferMetrics(cached.analysis)) {
    const analysis = await hydrateOverlayFromBodyArtifact(cached.analysis, cached.progress?.bodyPath || bodyArtifactPath(jobId));
    return { status: 'done', analysis, progress: cached.progress || null };
  }
  if (!cached && activeUploadJobs.has(jobId)) return { notFound: true };
  const persist = (patch) => writeAnalysisCache(jobId, { ...readAnalysisCache(jobId), ...patch });
  const shot = shotStore.getShotByJobId(jobId);
  const shotProgress = shot?.progress || null;
  const shotMetadata = shot?.metadata || null;
  const diskBodyPath = bodyArtifactPath(jobId);
  const diskBodyExists = typeof diskBodyPath === 'string' && fs.existsSync(diskBodyPath);
  const cachedStatus = cached?.status;
  let cachedAnalysis = cached?.analysis || null;
  const cachedProgress = cached?.progress || null;
  const cachedMetaPath =
    cachedProgress?.metaPath || cached?.metaPath || shotProgress?.metaPath || shotMetadata?.metaPath || null;
  const cachedBodyPath =
    cachedProgress?.bodyPath ||
    shotProgress?.bodyPath ||
    shotMetadata?.bodyPath ||
    (diskBodyExists ? diskBodyPath : null);
  cachedAnalysis = await hydrateOverlayFromBodyArtifact(cachedAnalysis, cachedBodyPath);
  const cachedClubPath = cachedProgress?.clubPath || shotProgress?.clubPath || cachedMetaPath || null;
  const cachedFusionPath = cachedProgress?.fusionPath || shotProgress?.fusionPath || null;
  const cachedDetail = {
    ...(cachedProgress?.detail && typeof cachedProgress.detail === 'object' ? cachedProgress.detail : {}),
    ...(shotProgress?.detail && typeof shotProgress.detail === 'object' ? shotProgress.detail : {}),
    ...(diskBodyExists ? { bodyRecoveredFromDisk: true } : {}),
  };

  const statusUrl = inferUrl(`/v1/jobs/${encodeURIComponent(jobId)}`);
  if (!statusUrl) {
    if (cached) {
      return { status: cachedStatus || 'failed', analysis: cachedAnalysis, progress: cachedProgress };
    }
    const analysis = buildInferErrorAnalysis(jobId, 'infer service not configured');
    const progress = buildAnalysisProgress('failed', {
      analysisPath: 'infer',
      message: 'infer service not configured',
    });
    persist({
      status: 'failed',
      analysis,
      errorCode: analysis.errorCode,
      errorMessage: analysis.errorMessage,
      progress,
    });
    return { status: 'failed', analysis, progress };
  }

  const statusRes = await inferFetchJson(statusUrl, { timeoutMs: 1500 });
  if (!statusRes.ok) {
    if (statusRes.status === 404) {
      if (cached) {
        return { status: cachedStatus || 'done', analysis: cachedAnalysis, progress: cachedProgress };
      }
      return { notFound: true };
    }
    if (cached) {
      return { status: cachedStatus || 'failed', analysis: cachedAnalysis, progress: cachedProgress };
    }
    const analysis = buildInferErrorAnalysis(jobId, 'infer service unavailable');
    const progress = buildAnalysisProgress('failed', {
      analysisPath: 'infer',
      message: 'infer service unavailable',
    });
    persist({
      status: 'failed',
      analysis,
      errorCode: analysis.errorCode,
      errorMessage: analysis.errorMessage,
      progress,
    });
    return { status: 'failed', analysis, progress };
  }

  const mappedStatus = mapInferStatus(statusRes.json?.status || statusRes.json?.state);
  let analysis = cachedAnalysis;
  let progress = buildGroupedProgress(
    mappedStatus === 'done' ? 'fusion_succeeded' : mappedStatus === 'failed' ? 'failed' : 'fusion_running',
    {
      analysisPath: 'infer',
      metaPath: cachedMetaPath,
      bodyPath: cachedBodyPath,
      clubPath: cachedClubPath,
      fusionPath: mappedStatus === 'done' ? cachedFusionPath || inferAnalysisPath(jobId) : cachedFusionPath,
      detail: cachedDetail,
    },
  );

  if (mappedStatus === 'done' || mappedStatus === 'failed') {
    const resultUrl = inferUrl(`/v1/jobs/${encodeURIComponent(jobId)}/result`);
    if (resultUrl) {
      const resultRes = await inferFetchJson(resultUrl, { timeoutMs: 3000 });
      if (resultRes.ok) {
        const resultStatus = mapInferStatus(resultRes.json?.status || resultRes.json?.state);
        if ((resultStatus === 'running' || resultStatus === 'pending') && mappedStatus !== 'failed') {
          progress = buildGroupedProgress('fusion_running', {
            analysisPath: 'infer',
            metaPath: cachedMetaPath,
            bodyPath: cachedBodyPath,
            clubPath: cachedClubPath,
            fusionPath: cachedFusionPath,
            message: 'infer 결과를 준비 중입니다.',
            detail: cachedDetail,
          });
          persist({
            status: 'running',
            analysis: cachedAnalysis,
            errorCode: null,
            errorMessage: null,
            progress,
          });
          return { status: 'running', analysis: cachedAnalysis, progress };
        }
        analysis = normalizeInferResult(jobId, mappedStatus, resultRes.json);
        await hydrateOverlayFromBodyArtifact(analysis, cachedBodyPath);
        const resultSucceeded = analysis?.status === 'succeeded' && analysis?.errorCode == null;
        const nextStatus = resultSucceeded ? 'done' : mappedStatus;
        progress = buildGroupedProgress(resultSucceeded ? 'fusion_succeeded' : 'failed', {
          analysisPath: 'infer',
          metaPath: cachedMetaPath,
          bodyPath: cachedBodyPath,
          clubPath: cachedClubPath,
          fusionPath: resultSucceeded ? cachedFusionPath || inferAnalysisPath(jobId) : cachedFusionPath,
          message: resultSucceeded ? undefined : analysis?.errorMessage || PROGRESS_STAGE_META.failed.message,
          detail: cachedDetail,
        });
        if (analysis && typeof analysis === 'object') {
          analysis.progress = progress;
          const latest = readAnalysisCache(jobId);
          const saved = latest?.dtlClubRefreshSource;
          const currentShot = shotStore.getShotByJobId(jobId);
          const source = currentShot?.metadata?.analysisInput?.path || currentShot?.media?.path;
          const body = latest?.progress?.bodyPath || currentShot?.metadata?.bodyPath || bodyArtifactPath(jobId);
          const sameFile = (identity, file) => identity && typeof file === 'string'
            && identity.path === path.resolve(file) && matchesVideoIdentity(identity, fs.statSync(file));
          try {
            if (latest?.dtlClubPointsV2?.status === 'succeeded' && saved
              && saved.metaPath === latest.dtlClubPointsV2.metaPath && saved.completedAt === latest.dtlClubPointsV2.completedAt
              && sameFile(saved.source, source) && sameFile(saved.input, saved.input?.path)
              && body && saved.body?.path === path.resolve(body)
              && (saved.body.absent ? !fs.existsSync(body) : sameFile(saved.body, body))
              && saved.viewpoint === (currentShot?.metadata?.viewpoint ?? null)
              && saved.handedness === (currentShot?.metadata?.handedness ?? null)) {
              analysis.debug = { ...(analysis.debug || {}), dtlClubPointsV2: latest.dtlClubPointsV2 };
            }
          } catch { /* A missing or changed input cannot reuse the saved observation. */ }
        }
        persist({
          status: nextStatus,
          analysis,
          errorCode: analysis?.errorCode ?? null,
          errorMessage: analysis?.errorMessage ?? null,
          progress,
        });
        if (nextStatus === 'done') scheduleDtlClubPointsV2Sidecar(jobId);
        return { status: nextStatus, analysis, progress };
      } else if (!analysis) {
        const errorAnalysis = buildInferErrorAnalysis(jobId, 'infer result unavailable');
        progress = buildAnalysisProgress('failed', {
          analysisPath: 'infer',
          metaPath: cached?.metaPath || null,
          message: 'infer result unavailable',
        });
        persist({
          status: 'failed',
          analysis: errorAnalysis,
          errorCode: errorAnalysis.errorCode,
          errorMessage: errorAnalysis.errorMessage,
          progress,
        });
        return { status: 'failed', analysis: errorAnalysis, progress };
      }
    }
  } else if (includeResult) {
    if (analysis && typeof analysis === 'object' && !analysis.progress) {
      analysis.progress = progress;
    }
    persist({
      status: mappedStatus,
      analysis,
      errorCode: analysis?.errorCode ?? null,
      errorMessage: analysis?.errorMessage ?? null,
      progress,
    });
    return { status: mappedStatus, analysis, progress };
  }

  if (analysis && typeof analysis === 'object' && !analysis.progress) {
    analysis.progress = progress;
  }
  persist({
    status: mappedStatus,
    analysis,
    errorCode: analysis?.errorCode ?? null,
    errorMessage: analysis?.errorMessage ?? null,
    progress,
  });
  return { status: mappedStatus, analysis, progress };
}

function buildShotJobResponse(jobId) {
  const shot = shotStore.getShotByJobId(jobId);
  if (!shot) return null;
  const analysis = buildJobAnalysisPayload(shot);
  return {
    ok: true,
    jobId,
    status: shot.status || analysis.status || 'succeeded',
    analysis,
    progress: analysis?.progress || shot.progress || null,
    errorCode: analysis?.errorCode ?? null,
    errorMessage: analysis?.errorMessage ?? null,
  };
}

async function respondJobStatus(req, res) {
  const jobId = req.params.jobId;
  const inferPayload = await fetchInferJobPayload(jobId, { includeResult: false });
  if (!inferPayload?.notFound) {
    return res.json({
      ok: true,
      jobId,
      status: inferPayload.status,
      analysis: inferPayload.analysis || null,
      progress: inferPayload.progress || inferPayload.analysis?.progress || null,
      errorCode: inferPayload.analysis?.errorCode ?? null,
      errorMessage: inferPayload.analysis?.errorMessage ?? null,
    });
  }

  const shotPayload = buildShotJobResponse(jobId);
  if (shotPayload) {
    return res.json(shotPayload);
  }

  return res.status(404).json({ ok: false, message: 'Job not found' });
}

async function respondJobResult(req, res) {
  const jobId = req.params.jobId;
  const inferPayload = await fetchInferJobPayload(jobId, { includeResult: true });
  if (!inferPayload?.notFound) {
    return res.json({
      ok: true,
      jobId,
      status: inferPayload.status,
      analysis: inferPayload.analysis || null,
      progress: inferPayload.progress || inferPayload.analysis?.progress || null,
      errorCode: inferPayload.analysis?.errorCode ?? null,
      errorMessage: inferPayload.analysis?.errorMessage ?? null,
    });
  }

  const shotPayload = buildShotJobResponse(jobId);
  if (shotPayload) {
    return res.json(shotPayload);
  }

  return res.status(404).json({ ok: false, message: 'Job not found' });
}

const manualVideoClocks = createVideoClock({
  hash: hashVideoFile,
  probe: async (inputPath) => {
    const { ffprobe } = await ensureFfmpegAvailability();
    if (!ffprobe) throw new Error('Video clock probe unavailable');
    // Cap packets so unsupported long videos cannot consume unbounded memory.
    const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-read_intervals', '%+#7201', '-show_frames', '-show_streams',
      '-show_entries', 'frame=best_effort_timestamp_time:stream=nb_frames', '-of', 'json', inputPath], { timeoutMs: 30_000 });
    const data = JSON.parse(stdout);
    const raw = data.frames.map(frame => typeof frame.best_effort_timestamp_time === 'string'
      && frame.best_effort_timestamp_time.trim() ? Number(frame.best_effort_timestamp_time) * 1000 : NaN);
    return { times: raw.map(t => Math.round((t - raw[0]) * 1000) / 1000), frameCount: Number(data.streams?.[0]?.nb_frames) };
  },
});
function resolveReviewReference(jobId, videoSha256, { requireRevision3 = false, allowManual = false } = {}) {
  const shot = shotStore.getShotByJobId(jobId);
  if (!shot) return null;
  let impact = impactReviews.read(jobId);
  let manual = allowManual ? manualVideoClocks.read(jobId, videoSha256) : null;
  try {
    if (manual && fs.realpathSync(shot.metadata?.analysisInput?.path || shot.media?.path) !== manual.inputPath) manual = null;
  } catch { manual = null; }
  try {
    if (impact && shot.metadata?.analysisInput?.path && fs.realpathSync(shot.metadata.analysisInput.path) !== fs.realpathSync(impact.inputPath)) impact = null;
  } catch { impact = null; }
  return selectVideoReference(impact, manual, videoSha256, { requireRevision3 });
}

app.get('/api/analyze/:jobId/video-clock', async (req, res) => {
  const { jobId } = req.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return res.sendStatus(400);
  const shot = shotStore.getShotByJobId(jobId);
  if (!shot) return res.status(404).json({ ok: false, error: '저장된 영상을 찾을 수 없습니다.' });
  if (shot.metadata?.viewpoint === 'face_on' || shot.metadata?.handedness === 'left') {
    return res.status(422).json({ ok: false, error: '현재 수동 골반 확인은 오른손 후방 영상만 지원합니다.' });
  }
  const status = readAnalysisCache(jobId)?.status || shot.status;
  if (['pending', 'queued', 'running', 'uploading'].includes(status)) {
    return res.status(409).json({ ok: false, error: '영상 준비가 끝난 뒤 다시 시도해 주세요.' });
  }
  const input = shot.metadata?.analysisInput?.path || shot.media?.path;
  try {
    const source = fs.realpathSync(input);
    const roots = [uploadDir, dataDir].map(root => fs.realpathSync(root));
    if (!roots.some(root => source.startsWith(`${root}${path.sep}`))) return res.sendStatus(403);
    const result = await manualVideoClocks.prepare(jobId, source);
    const current = shotStore.getShotByJobId(jobId);
    if (!current || fs.realpathSync(current.metadata?.analysisInput?.path || current.media?.path) !== source) {
      return res.status(409).json({ ok: false, error: '기록의 영상이 변경됐습니다. 다시 확인해 주세요.' });
    }
    return res.json(result);
  } catch (error) {
    return res.status(error.message === 'Video clock is busy' ? 503 : 422)
      .json({ ok: false, error: '영상의 프레임 시각을 확인하지 못했습니다. 다시 시도해 주세요.' });
  }
});

app.get('/api/analyze/:jobId/review-video', async (req, res) => {
  const { jobId } = req.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return res.sendStatus(400);
  const shot = shotStore.getShotByJobId(jobId);
  if (!shot) return res.sendStatus(404);
  const bound = req.query.v !== undefined;
  const cached = bound && typeof req.query.v === 'string'
    ? resolveReviewReference(jobId, req.query.v, { allowManual: true }) : null;
  if (bound && (typeof req.query.v !== 'string' || !/^[a-f0-9]{64}$/.test(req.query.v)
      || cached?.result?.videoSha256 !== req.query.v || !Array.isArray(cached.result.frameTimesMs)
      || cached.result.frameTimesMs.length < 4)) return res.sendStatus(409);
  const inputPath = bound ? cached?.inputPath : shot?.metadata?.analysisInput?.path || shot?.media?.path;
  if (!inputPath || !fs.existsSync(inputPath)) return res.sendStatus(bound ? 409 : 404);
  const stillMatches = async () => matchesVideoIdentity(cached, await fs.promises.stat(inputPath).catch(() => null));
  if (bound && !await stillMatches()) return res.sendStatus(409);
  const playbackPath = req.query.quality === 'original' ? inputPath : await reviewVideoPath(inputPath, bound ? cached.result.frameTimesMs : null);
  if (bound && !await stillMatches()) return res.sendStatus(409);
  // A known storage root keeps .converted out of Express's hidden request-path check.
  return res.sendFile(path.basename(playbackPath), { root: path.dirname(path.resolve(playbackPath)) });
});

app.post('/api/analyze/:jobId/club-review', (req, res) => {
  const { jobId } = req.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)
    || (req.body?.refresh !== undefined && typeof req.body.refresh !== 'boolean')) return res.sendStatus(400);
  const shot = shotStore.getShotByJobId(jobId);
  if (!shot) return res.sendStatus(404);
  if (shot.metadata?.viewpoint === 'face_on' || shot.metadata?.handedness === 'left') {
    return res.status(422).json({ ok: false, error: '현재 클럽 관측은 오른손 DTL 영상만 지원합니다.' });
  }
  const refresh = req.body?.refresh === true;
  const scheduled = scheduleDtlClubPointsV2Sidecar(jobId, { force: true, refresh });
  if (scheduled.reason === 'primary analysis unavailable') return res.status(409).json({ ok: false, error: '영상 분석이 끝난 뒤 다시 시도해 주세요.' });
  if (refresh && scheduled.reason === 'already scheduled' && !scheduled.refreshId) return res.status(409).json({ ok: false, error: '클럽 분석이 진행 중입니다. 완료 후 다시 시도해 주세요.' });
  return res.status(202).json({ ok: true, ...scheduled });
});

app.get('/api/analyze/:jobId/club-review', (req, res) => {
  const { jobId } = req.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return res.sendStatus(400);
  if (!shotStore.getShotByJobId(jobId)) return res.sendStatus(404);
  const cache = readAnalysisCache(jobId);
  let refresh = cache?.dtlClubRefresh || null;
  if (refresh && ['queued', 'running'].includes(refresh.status) && activeDtlClubPointsV2.get(jobId) !== refresh.id) {
    refresh = { ...refresh, status: 'interrupted' };
  }
  return res.json({ ok: true, jobId, sidecar: cache?.dtlClubPointsV2 || null, refresh });
});

app.post('/api/analyze/:jobId/impact-review', async (req, res) => {
  const { jobId } = req.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId) || (req.body?.automatic !== true && req.body?.confirmedInput !== true)) {
    return res.status(400).json({ ok: false, error: '임팩트 후보 요청 방식이 필요합니다.' });
  }
  let shot = shotStore.getShotByJobId(jobId);
  if (!shot) return res.status(404).json({ ok: false, error: '저장된 영상을 찾을 수 없습니다.' });
  // A new upload may still be converting; use its prepared input rather than racing the conversion.
  const deadline = Date.now() + 120000;
  while (['queued', 'running'].includes(shot.status)
    && ['upload_received', 'video_preparing', 'pose_running'].includes(shot.progress?.stage)
    && Date.now() < deadline) {
    await sleep(500);
    shot = shotStore.getShotByJobId(jobId);
    if (!shot) return res.status(404).json({ ok: false, error: '저장된 영상을 찾을 수 없습니다.' });
  }
  if (shot.metadata?.viewpoint === 'face_on' || shot.metadata?.handedness === 'left') {
    return res.status(422).json({ ok: false, error: '현재 임팩트 후보는 오른손 DTL 영상만 지원합니다.' });
  }
  let inputPath = shot.metadata?.analysisInput?.path || shot.media?.path;
  if (!inputPath || !fs.existsSync(inputPath)) return res.status(404).json({ ok: false, error: '원본 영상이 Pi에 없습니다.' });
  try {
    if (!shot.metadata?.analysisInput?.path) {
      const prepared = await prepareVideoForAnalysis(inputPath, shot.media?.filename || path.basename(inputPath));
      if (!prepared.ok) throw new Error('영상을 준비하지 못했습니다.');
      inputPath = prepared.path;
    }
    const bodyPath = shot.metadata?.bodyPath || bodyArtifactPath(jobId);
    const result = await scheduleAutomaticImpact(jobId, inputPath, fs.existsSync(bodyPath) ? bodyPath : null);
    return res.json(result);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message || '임팩트 후보를 계산하지 못했습니다.' });
  }
});

app.get('/api/analyze/:jobId/pose-overlay', async (req, res) => {
  const { jobId } = req.params;
  const videoSha256 = req.query.v;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId) || typeof videoSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(videoSha256)) {
    return res.status(400).json({ ok: false, error: '영상 식별 정보를 확인해 주세요.' });
  }
  const shot = shotStore.getShotByJobId(jobId);
  if (!shot) return res.status(404).json({ ok: false, error: '저장된 영상을 찾을 수 없습니다.' });
  const status = readAnalysisCache(jobId)?.status || shot.status;
  if (['pending', 'queued', 'running'].includes(status)) return res.status(409).json({ ok: false, error: '영상 분석이 끝난 뒤 다시 시도해 주세요.' });
  const cached = resolveReviewReference(jobId, videoSha256, { requireRevision3: true, allowManual: true });
  const times = cached?.result?.frameTimesMs;
  if (cached?.result?.videoSha256 !== videoSha256 || cached?.result?.timingRevision !== 3
      || !Array.isArray(times) || times.length < 4 || times.length > 7200
      || !times.every((t, i) => Number.isFinite(t) && t >= 0 && t <= 30000 && (i === 0 || t > times[i - 1]))) {
    return res.status(409).json({ ok: false, error: '영상의 프레임 시각을 다시 확인해 주세요.' });
  }
  const inputPath = cached.inputPath;
  const bodyPath = shot.metadata?.bodyPath || bodyArtifactPath(jobId);
  try {
    if (!inputPath || !fs.existsSync(inputPath) || !fs.existsSync(bodyPath)) return res.status(404).json({ ok: false, error: '영상 또는 자세 분석이 없습니다.' });
    const originalBody = fs.statSync(bodyPath);
    if (!matchesVideoIdentity(cached, fs.statSync(inputPath))) return res.status(409).json({ ok: false, error: '영상이 변경됐습니다. 다시 확인해 주세요.' });
    const response = await inferFetchJson(inferUrl('/v1/pose-overlay'), { method: 'POST', timeoutMs: 30000, body: { jobId, inputPath, bodyPath } });
    if (!response.ok) return res.status(response.status === 409 ? 409 : 422).json({ ok: false, error: '영상과 자세 표시의 연결을 확인하지 못했습니다.' });
    const currentBody = fs.statSync(bodyPath);
    if (!matchesVideoIdentity(cached, fs.statSync(inputPath)) || !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => originalBody[key] === currentBody[key])) {
      return res.status(409).json({ ok: false, error: '영상이나 자세 분석이 변경됐습니다. 다시 확인해 주세요.' });
    }
    const result = response.json, frames = result?.poseFrames;
    if (result?.ok !== true || result.jobId !== jobId || result.timeSource !== 'video_pts'
        || !['ready', 'unavailable'].includes(result.status) || !Array.isArray(frames) || frames.length > 7200
        || (result.status === 'ready' ? frames.length === 0 : frames.length !== 0)
        || !frames.every((frame, i) => frame && Number.isSafeInteger(frame.frame) && frame.frame >= 0 && frame.frame < times.length
          && (!i || frame.frame > frames[i - 1].frame) && frame.timeMs === times[frame.frame]
          && frame.keypoints && typeof frame.keypoints === 'object' && !Array.isArray(frame.keypoints)
          && Object.entries(frame.keypoints).every(([name, point]) => /^(nose|(left|right)_(shoulder|elbow|wrist|hip|knee|ankle))$/.test(name)
            && Array.isArray(point) && point.length === 3 && point.every(Number.isFinite) && point[2] >= 0 && point[2] <= 1))
        || (result.status === 'ready' && !frames.some(frame => Object.keys(frame.keypoints).length > 0))) {
      return res.status(502).json({ ok: false, error: '자세 프레임 시각을 확인하지 못했습니다.' });
    }
    return res.json({ ok: true, jobId, status: result.status, timeSource: 'video_pts', poseFrames: frames, videoSha256 });
  } catch (error) {
    return res.status(502).json({ ok: false, error: '자세 표시를 준비하지 못했습니다. 다시 시도해 주세요.' });
  }
});

app.post('/api/analyze/:jobId/practice-review', async (req, res) => {
  const { jobId } = req.params;
  const { addressMs, comparisonMs, viewpoint, confirmedFrames, videoSha256, mode, impactFrameIndex } = req.body || {};
  const coaching = mode === 'coaching';
  const preview = mode === 'preview' || coaching;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId) || !Number.isFinite(addressMs) || !Number.isFinite(comparisonMs)
      || addressMs < 0 || comparisonMs > 30000 || comparisonMs - addressMs < 150
      || viewpoint !== 'down_the_line' || (!preview && confirmedFrames !== true)
      || (videoSha256 !== undefined && !/^[a-f0-9]{64}$/.test(videoSha256))
      || (impactFrameIndex !== undefined && (!coaching || !Number.isSafeInteger(impactFrameIndex) || impactFrameIndex < 0))
      || (coaching && typeof videoSha256 !== 'string')) {
    return res.status(400).json({ ok: false, error: '고정된 DTL 영상에서 어드레스와 임팩트 직전 장면을 확인해 주세요.' });
  }
  const shot = shotStore.getShotByJobId(jobId);
  if (!shot) return res.status(404).json({ ok: false, error: '저장된 영상을 찾을 수 없습니다.' });
  // Completed analysis reads can leave the capture record's status behind.
  const analysisStatus = readAnalysisCache(jobId)?.status || shot.status;
  if (['pending', 'queued', 'running'].includes(analysisStatus)) return res.status(409).json({ ok: false, error: '영상 분석이 끝난 뒤 다시 시도해 주세요.' });
  if (shot.metadata?.viewpoint === 'face_on' || (coaching && shot.metadata?.handedness === 'left')) return res.status(422).json({ ok: false, error: '이 골반 확인은 오른손 DTL 영상만 지원합니다.' });
  const cached = videoSha256 ? resolveReviewReference(jobId, videoSha256,
    { requireRevision3: true, allowManual: coaching && impactFrameIndex !== undefined }) : null;
  if (videoSha256 && (cached?.result?.videoSha256 !== videoSha256 || cached?.result?.timingRevision !== 3)) {
    return res.status(409).json({ ok: false, error: '영상이 변경됐습니다. 새로고침 후 장면을 다시 선택해 주세요.' });
  }
  const inputPath = videoSha256 ? cached.inputPath : shot.metadata?.analysisInput?.path || shot.media?.path;
  const bodyPath = shot.metadata?.bodyPath || bodyArtifactPath(jobId);
  if (!inputPath || !fs.existsSync(inputPath) || !fs.existsSync(bodyPath)) {
    return res.status(404).json({ ok: false, error: '영상 또는 자세 분석이 없습니다. 영상을 다시 분석해 주세요.' });
  }
  if (cached) {
    const stat = fs.statSync(inputPath);
    if (!matchesVideoIdentity(cached, stat)) {
      return res.status(409).json({ ok: false, error: '영상이 변경됐습니다. 새로고침 후 장면을 다시 선택해 주세요.' });
    }
  }
  let impactMs = cached?.result?.candidate?.timeMs;
  let effectiveComparisonMs = comparisonMs;
  if (impactFrameIndex !== undefined) {
    const times = cached?.result?.frameTimesMs;
    if (!Array.isArray(times) || times.length < 4 || times.length > 7200
        || !times.every((time, index) => Number.isFinite(time) && time >= 0 && time <= 30000 && (index === 0 || time > times[index - 1]))) {
      return res.status(409).json({ ok: false, error: '영상의 프레임 시각을 확인할 수 없습니다. 새로고침 후 다시 선택해 주세요.' });
    }
    impactMs = times[impactFrameIndex];
    if (!Number.isFinite(impactMs) || impactMs - addressMs < 230 || Math.abs(comparisonMs - (impactMs - 80)) > 1) {
      return res.status(400).json({ ok: false, error: '준비 자세보다 뒤의 타격 장면을 다시 선택해 주세요.' });
    }
    effectiveComparisonMs = impactMs - 80;
  }
  try {
    const response = await inferFetchJson(inferUrl(coaching ? '/v1/coaching-review' : preview ? '/v1/practice-preview' : '/v1/practice-review'), {
      method: 'POST', timeoutMs: coaching ? 30000 : 10000,
      body: { jobId, inputPath, bodyPath, addressMs, comparisonMs: effectiveComparisonMs, viewpoint, ...(preview ? { impactMs } : { confirmedFrames }) },
    });
    if (!response.ok) return res.status(!response.status || response.status >= 500 ? 502 : response.status === 409 ? 409 : 422).json({ ok: false, error: typeof response.json?.detail === 'string' ? response.json.detail : '자세 비교를 완료하지 못했습니다.' });
    if (cached && (!fs.existsSync(inputPath) || !matchesVideoIdentity(cached, fs.statSync(inputPath)))) {
      return res.status(409).json({ ok: false, error: '영상이 변경됐습니다. 새로고침 후 장면을 다시 선택해 주세요.' });
    }
    return res.json(response.json);
  } catch (error) {
    return res.status(502).json({ ok: false, error: '자세 분석 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  }
});

app.get('/api/analyze/:jobId', respondJobStatus);
app.get('/api/analyze/:jobId/result', respondJobResult);

app.post('/api/archive/:jobId/retry', (req, res) => {
  const jobId = req.params.jobId;
  if (!isSafeJobId(jobId)) {
    return res.status(400).json({ ok: false, message: 'Invalid jobId' });
  }
  const cache = readAnalysisCache(jobId);
  if (!cache || !['done', 'failed'].includes(cache.status)) {
    return res.status(404).json({ ok: false, message: 'Completed analysis cache not found' });
  }
  if (!nasArchive.enabled) {
    return res.status(503).json({ ok: false, message: 'NAS archive is not configured' });
  }
  const state = cache.nasArchive?.state;
  if (isNasArchiveComplete(cache.nasArchive)) {
    return res.status(409).json({ ok: false, message: 'NAS archive is already complete' });
  }
  if (['pending', 'uploading', 'retrying'].includes(state)) {
    return res.status(202).json({ ok: true, jobId, scheduled: false, archive: cache.nasArchive });
  }
  const scheduled = queueNasArchive(cache, { force: true });
  const refreshed = readAnalysisCache(jobId);
  return res.status(scheduled ? 202 : 500).json({
    ok: scheduled,
    jobId,
    scheduled,
    archive: refreshed?.nasArchive || null,
    message: scheduled ? null : 'Unable to schedule NAS archive',
  });
});

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
    const shot = queueUploadedShotAnalysis(req.file, {
      ...(req.body || {}),
      force: toBoolean(req.body?.force) || toBoolean(req.query?.force),
    });
    return res.json({
      ok: true,
      file: req.file.filename,
      url: uploadsUrl(req.file.filename),
      originalName: req.file.originalname,
      shot,
      progress: shot.progress || null,
    });
  } catch (err) {
    console.error('upload with analyze failed', err);
    return res.status(500).json({
      ok: false,
      message: err.message || 'Analysis failed',
      errorMessage: err.message || 'Analysis failed',
      errorCode: err.code === 'SHOT_STORE_UNAVAILABLE' ? err.code : undefined,
    });
  }
});

// List uploaded files
app.get('/api/files', (_req, res) => {
  try {
    const shots = shotStore.listShots();
    const entries = shots.map(mapShotToFileEntry);
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message, errorCode: err.code === 'SHOT_STORE_UNAVAILABLE' ? err.code : undefined });
  }
});

// List uploaded mp4 files with analysis status so the frontend can show an "Analyze" button
app.get('/api/files/detail', async (req, res) => {
  try {
    const summary = req.query.summary === 'true';
    const requestedIds = typeof req.query.jobIds === 'string' ? req.query.jobIds.split(',') : null;
    if (requestedIds && (requestedIds.length > 200 || requestedIds.some((id) => !isSafeJobId(id)))) {
      return res.status(400).json({ ok: false, message: 'Invalid jobIds' });
    }
    const wanted = requestedIds ? new Set(requestedIds) : null;
    const shotsByFilename = new Map(shotStore.listShots().map((shot) => [shot.media?.filename, shot]));
    const entries = await fs.promises.readdir(uploadDir, { withFileTypes: true });
    const videoFiles = entries
      .filter((ent) => ent.isFile() && isSupportedVideoExt(ent.name))
      .filter((ent) => !wanted || wanted.has(shotsByFilename.get(ent.name)?.jobId || path.basename(ent.name, path.extname(ent.name))))
      .map((ent) => ent.name);

    const filesWithStatus = await Promise.all(
      videoFiles.map(async (filename) => {
        const shot = shotsByFilename.get(filename);
        const derivedJobId = path.basename(filename, path.extname(filename));
        // Upload filenames contain their own unique prefix and do not have to
        // equal the UUID analysis jobId.  Look up the cache with the shot's
        // canonical jobId whenever it is available.
        const cacheJobId = shot?.jobId || derivedJobId;
        const cached = readAnalysisCache(cacheJobId);
        const cachedAnalysis = cached?.analysis || null;
        const cachedStatus = cached?.status || null;
        const cachedFileStatus = cachedStatus ? mapCacheStatusToFileStatus(cachedStatus) : null;
        // The analysis cache is updated by infer polling while the original
        // shot record can retain its initial `running` value.  Prefer the
        // cache for both status and result so completed files leave the
        // pending list without requiring the shot record to be rewritten.
        const effectiveStatus =
          cachedFileStatus ||
          normalizeJobStatus(shot?.status) ||
          (shot?.analysis
            ? (looksLikeAnalysisFailure(shot.analysis) ? 'failed' : 'succeeded')
            : 'not-analyzed');
        const effectiveAnalysis = summary ? null : cached ? cachedAnalysis : shot ? buildJobAnalysisPayload(shot) : null;
        let stats;
        try {
          stats = await fs.promises.stat(path.join(uploadDir, filename));
        } catch {
          // ignore stat errors; keep lightweight listing
        }
        const errorCode =
          cachedAnalysis?.errorCode ??
          shot?.analysis?.errorCode ??
          cached?.errorCode ??
          null;
        const errorMessage =
          cachedAnalysis?.errorMessage ??
          shot?.analysis?.errorMessage ??
          cached?.errorMessage ??
          null;
        return {
          filename,
          url: uploadsUrl(filename),
          thumbnailUrl: localThumbnailUrl(cacheJobId),
          shotId: shot?.id || null,
          jobId: shot?.jobId || cached?.jobId || derivedJobId,
          sourceType: shot?.sourceType || shot?.metadata?.sourceType || null,
          analyzed: effectiveStatus === 'succeeded',
          status: effectiveStatus,
          errorCode,
          errorMessage,
          nasArchive: cached?.nasArchive ? { ...cached.nasArchive, artifacts: undefined } : null,
          metaPath: cached?.metaPath || shot?.metadata?.metaPath || null,
          size: stats?.size,
          modifiedAt: stats?.mtime?.toISOString(),
          analysis: effectiveAnalysis,
          progress: cached?.progress || shot?.progress || null,
        };
      }),
    );

    res.json({ ok: true, files: filesWithStatus });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message, errorCode: err.code === 'SHOT_STORE_UNAVAILABLE' ? err.code : undefined });
  }
});

app.get('/api/debug/infer/:jobId/frames/progress', (req, res) => {
  const jobId = req.params.jobId;
  if (!isSafeJobId(jobId)) {
    return res.status(400).json({ ok: false, message: 'Invalid jobId' });
  }
  const limit = Math.max(1, Math.min(240, Number(req.query.limit) || 120));
  const variant = req.query.variant === 'debug' ? 'debug' : 'main';
  const key = `${jobId}:${variant}:${limit}`;
  const current = activeDebugFrameRequests.get(key);
  if (!current) {
    return res.json({
      ok: true,
      jobId,
      variant,
      status: 'idle',
      completed: 0,
      total: 0,
      percent: 0,
    });
  }
  return res.json({
    ok: true,
    jobId,
    variant,
    status: current.status,
    completed: current.completed,
    total: current.total,
    percent: current.total > 0 ? Math.round((current.completed / current.total) * 100) : 0,
    currentFrame: current.currentFrame,
    startedAt: current.startedAt,
    updatedAt: current.updatedAt,
  });
});

app.get('/api/debug/infer/:jobId/frames', async (req, res) => {
  const jobId = req.params.jobId;
  if (!isSafeJobId(jobId)) {
    return res.status(400).json({ ok: false, message: 'Invalid jobId' });
  }

  const limit = Math.max(1, Math.min(240, Number(req.query.limit) || 120));
  const force = toBoolean(req.query.force);
  const variant = req.query.variant === 'debug' ? 'debug' : 'main';
  const requestKey = `${jobId}:${variant}:${limit}`;
  const existingRequest = activeDebugFrameRequests.get(requestKey);
  if (existingRequest) {
    return res.status(409).json({
      ok: false,
      jobId,
      variant,
      code: 'DEBUG_FRAMES_ALREADY_PROCESSING',
      message: '동일한 Job의 프레임을 이미 생성하고 있습니다.',
      status: existingRequest.status,
      completed: existingRequest.completed,
      total: existingRequest.total,
    });
  }

  const abortController = new AbortController();
  const requestProgress = {
    status: 'preparing',
    completed: 0,
    total: 0,
    currentFrame: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  activeDebugFrameRequests.set(requestKey, requestProgress);
  const cancelDisconnectedRequest = () => {
    if (res.writableEnded) return;
    requestProgress.status = 'cancelled';
    requestProgress.updatedAt = new Date().toISOString();
    abortController.abort();
    if (activeDebugFrameRequests.get(requestKey) === requestProgress) {
      activeDebugFrameRequests.delete(requestKey);
    }
  };
  res.once('close', cancelDisconnectedRequest);

  try {
  let metaPath = resolveDebugMetaPath(jobId, variant);
  const sourceVideoPath = resolveDebugVideoPath(jobId);
  if (!metaPath) {
    return res.status(404).json({ ok: false, message: 'meta not found', jobId });
  }
  if (!sourceVideoPath) {
    return res.status(404).json({ ok: false, message: 'video not found', jobId, metaPath });
  }
  const shot = shotStore.getShotByJobId(jobId);
  const storedInputPath = shot?.metadata?.analysisInput?.path;
  let videoPath = storedInputPath && fs.existsSync(storedInputPath) ? storedInputPath : sourceVideoPath;
  let imageSource = storedInputPath && fs.existsSync(storedInputPath) ? 'analysis-input' : 'source-video';
  if (videoPath === sourceVideoPath) {
    const filename = shot?.media?.filename || path.basename(sourceVideoPath);
    const prepared = await prepareVideoForAnalysis(sourceVideoPath, filename);
    if (prepared.ok !== false && prepared.path) {
      videoPath = prepared.path;
      imageSource = prepared.converted ? `prepared-${prepared.conversion || 'converted'}` : 'source-video';
    }
  }

  let meta = await readJsonFile(metaPath);
  let frames = Array.isArray(meta?.frames) ? meta.frames : [];
  if (!frames.length) {
    const restoredMetaPath = await restoreMetaArtifactFromNas(jobId, variant);
    if (restoredMetaPath) {
      metaPath = restoredMetaPath;
      meta = await readJsonFile(metaPath);
      frames = Array.isArray(meta?.frames) ? meta.frames : [];
    }
  }
  if (!frames.length) {
    return res.status(404).json({ ok: false, message: 'meta frames missing', jobId, metaPath });
  }
  const sourceTimeline = await debugSourceTimeline(jobId, videoPath, frames, abortController.signal);
  const bodyPath = bodyArtifactPath(jobId);
  const bodyArtifact = await readJsonFile(bodyPath);
  const bodyFrames = Array.isArray(bodyArtifact?.frames) ? bodyArtifact.frames : [];
  const bodyFrameByIndex = new Map(
    bodyFrames
      .map((frame) => [Number(frame?.frameIndex), frame])
      .filter(([frameIndex]) => Number.isFinite(frameIndex)),
  );
  const nearestBodyFrame = (targetFrameIndex) => {
    if (!Number.isFinite(targetFrameIndex) || !bodyFrames.length) return null;
    const best = bodyFrames
      .map((frame) => ({
        frame,
        delta: Math.abs(Number(frame?.frameIndex) - targetFrameIndex),
      }))
      .filter((item) => Number.isFinite(item.delta))
      .sort((a, b) => a.delta - b.delta)[0];
    return best && best.delta <= 2 ? best.frame : null;
  };

  const jobFrameDir = path.join(inferDebugFrameDir, jobId);
  if (force) {
    await fs.promises.rm(jobFrameDir, { recursive: true, force: true }).catch(() => {});
  }
  await fs.promises.mkdir(jobFrameDir, { recursive: true });

  const selected = selectDebugFrames(frames, limit);
  requestProgress.status = 'processing';
  requestProgress.total = selected.length;
  requestProgress.updatedAt = new Date().toISOString();
  const debugFrames = [];
  const labelCounts = {};
  const rejectedLabelCounts = {};
  for (const { frame, index } of selected) {
    if (abortController.signal.aborted) {
      const error = new Error('debug frame request cancelled');
      error.name = 'AbortError';
      throw error;
    }
    const frameIndex = Number(frame?.frame ?? frame?.frameIndex ?? index);
    const safeFrameIndex = sourceTimeline ? sourceTimeline.indices[index]
      : Number.isFinite(frameIndex) ? Math.round(frameIndex) : index;
    const timeMs = sourceTimeline ? Math.round(sourceTimeline.times[safeFrameIndex])
      : frameTimeMs(frame, index, meta?.fps);
    requestProgress.currentFrame = safeFrameIndex;
    requestProgress.updatedAt = new Date().toISOString();
    const imageName = `frame_${String(safeFrameIndex).padStart(5, '0')}_n${String(safeFrameIndex).padStart(5, '0')}_${String(timeMs).padStart(6, '0')}.jpg`;
    const imagePath = path.join(jobFrameDir, imageName);
    await extractDebugFrameImage(videoPath, imagePath, {
      timeMs,
      frameIndex: safeFrameIndex,
      signal: abortController.signal,
    });
    const bodyFrame = bodyFrameByIndex.get(safeFrameIndex) || nearestBodyFrame(safeFrameIndex);
    const rawDetections = (Array.isArray(frame?.detections) ? frame.detections : [])
      .map(normalizeDebugDetection)
      .filter(Boolean);
    const rejectedDetections = [];
    const detections = rawDetections.filter((det) => {
      const validation = validateDebugDetection(det, bodyFrame);
      if (validation.accepted) return true;
      rejectedDetections.push({ ...det, rejectionReason: validation.reason });
      rejectedLabelCounts[det.label] = (rejectedLabelCounts[det.label] || 0) + 1;
      return false;
    });
    detections.forEach((det) => {
      labelCounts[det.label] = (labelCounts[det.label] || 0) + 1;
    });
    debugFrames.push({
      index,
      frame: safeFrameIndex,
      timeMs,
      imageUrl: `/debug/infer-frames/${encodeURIComponent(jobId)}/${encodeURIComponent(imageName)}`,
      detections,
      rawDetectionCount: rawDetections.length,
      rejectedDetections,
      keypoints: bodyFrame?.keypoints || null,
    });
    requestProgress.completed += 1;
    requestProgress.updatedAt = new Date().toISOString();
  }

  requestProgress.status = 'succeeded';
  requestProgress.currentFrame = null;
  requestProgress.updatedAt = new Date().toISOString();
  return res.json({
    ok: true,
    jobId,
    variant,
    metaPath,
    videoPath,
    sourceVideoPath,
    imageSource,
    meta: {
      fps: meta?.fps ?? null,
      width: meta?.width ?? null,
      height: meta?.height ?? null,
      durationMs: meta?.durationMs ?? null,
      frames: frames.length,
      timeBasis: sourceTimeline ? (sourceTimeline.sourceAligned ? 'source_pts' : 'video_pts_unverified') : 'fps_estimate',
      legacyFrameNumbersChanged: !!sourceTimeline?.sourceAligned && frames.some((frame, index) => {
        const previous = Number(frame?.frame ?? frame?.frameIndex ?? index);
        return sourceTimeline.indices[index] !== (Number.isFinite(previous) ? Math.round(previous) : index);
      }),
    },
    body: {
      bodyPath: bodyArtifact ? bodyPath : null,
      analysisVersion: bodyArtifact?.analysisVersion || null,
      poseAvailable: bodyArtifact?.meta?.poseAvailable ?? null,
      poseFrames: bodyArtifact?.debug?.poseFrames ?? null,
      wristFrames: bodyArtifact?.debug?.wristFrames ?? null,
    },
    labelCounts,
    rejectedLabelCounts,
    frames: debugFrames,
  });
  } catch (error) {
    if (abortController.signal.aborted || error?.name === 'AbortError') {
      if (!res.headersSent && !res.destroyed) {
        return res.status(499).json({
          ok: false,
          jobId,
          variant,
          code: 'DEBUG_FRAMES_CANCELLED',
          message: '프레임 생성 요청이 취소되었습니다.',
        });
      }
      return;
    }
    requestProgress.status = 'failed';
    requestProgress.updatedAt = new Date().toISOString();
    if (!res.headersSent) {
      return res.status(500).json({
        ok: false,
        jobId,
        variant,
        code: 'DEBUG_FRAMES_FAILED',
        message: error?.message || '프레임 생성에 실패했습니다.',
      });
    }
  } finally {
    res.off('close', cancelDisconnectedRequest);
    if (activeDebugFrameRequests.get(requestKey) === requestProgress) {
      activeDebugFrameRequests.delete(requestKey);
    }
  }
});

app.get('/api/debug/infer/:jobId/annotation', async (req, res) => {
  const jobId = req.params.jobId;
  if (!isSafeJobId(jobId)) {
    return res.status(400).json({ ok: false, message: 'Invalid jobId' });
  }
  try {
    const annotation = await swingTrackingAnnotations.load(jobId);
    return res.json({ ok: true, jobId, annotation });
  } catch (error) {
    return res.status(500).json({ ok: false, jobId, message: error.message });
  }
});

app.get('/api/debug/swing-tracking/annotations', async (_req, res) => {
  try {
    const annotations = await swingTrackingAnnotations.list();
    return res.json({
      ok: true,
      count: annotations.length,
      target: 30,
      annotations,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

// Shadow mode only: create V2 candidates from manually labelled DTL jobs. It
// never submits the primary analysis pipeline or changes primary events.
app.post('/api/debug/swing-tracking/v2-backfill', async (req, res) => {
  const requestedLimit = Number(req.body?.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.round(requestedLimit), 100)) : 100;
  const force = req.body?.force === true;
  try {
    const annotations = await swingTrackingAnnotations.list();
    const result = { requested: Math.min(annotations.length, limit), queued: 0, skipped: 0, unavailable: 0 };
    for (const item of annotations.slice(0, limit)) {
      // `list()` already calculates the labelled-event count. Do not await a
      // file read per job here: yielding inside the loop lets the serial V2
      // worker start before this request has finished queueing the batch.
      if (!Number.isFinite(item.events) || item.events < 1) {
        result.skipped += 1;
        continue;
      }
      const scheduled = scheduleDtlClubPointsV2Sidecar(item.jobId, { force });
      if (scheduled.scheduled) result.queued += 1;
      else if (scheduled.reason === 'primary analysis unavailable') result.unavailable += 1;
      else result.skipped += 1;
    }
    return res.status(202).json({ ok: true, mode: 'shadow', ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.get('/api/debug/swing-tracking/v2-event-benchmark', async (_req, res) => {
  try {
    return res.json({ ok: true, mode: 'shadow', benchmark: await buildDtlClubPointsV2EventBenchmark() });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.post('/api/debug/infer/:jobId/annotation', async (req, res) => {
  const jobId = req.params.jobId;
  if (!isSafeJobId(jobId)) {
    return res.status(400).json({ ok: false, message: 'Invalid jobId' });
  }
  const identityError = validateAnnotationIdentity(jobId, req.body);
  if (identityError) {
    return res.status(409).json({
      ok: false,
      jobId,
      ...identityError,
    });
  }
  try {
    const annotation = await swingTrackingAnnotations.save(jobId, req.body);
    const annotationPath = path.join(swingTrackingAnnotations.annotationDir, `${jobId}.json`);
    const archive = queueSwingTrackingAnnotationArchive(jobId, annotationPath, annotation);
    return res.json({
      ok: true,
      jobId,
      annotation,
      annotationPath,
      archive,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, jobId, message: error.message });
  }
});

app.post('/api/debug/swing-tracking/datasets/:version/archive', (req, res) => {
  try {
    const archive = queueSwingTrackingDatasetArchive(req.params.version);
    return res.status(archive.state === 'pending' ? 202 : 200).json({
      ok: true,
      datasetVersion: req.params.version,
      archive,
    });
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message });
  }
});

// Deliberately separate from /api/analyze: this creates only temporary
// derived-video detection metadata and a comparison report. It never writes a
// production analysis cache or asks NAS archival to run.
app.post('/api/labs/club-preprocess/:jobId', async (req, res) => {
  const jobId = req.params.jobId;
  if (!isSafeJobId(jobId)) {
    return res.status(400).json({ ok: false, message: 'Invalid jobId' });
  }
  const sourceVideoPath = resolveDebugVideoPath(jobId);
  if (!sourceVideoPath) {
    return res.status(404).json({ ok: false, message: 'video not found', jobId });
  }
  const shot = shotStore.getShotByJobId(jobId);
  const storedInputPath = shot?.metadata?.analysisInput?.path;
  let inputPath = storedInputPath && fs.existsSync(storedInputPath) ? storedInputPath : sourceVideoPath;
  if (inputPath === sourceVideoPath) {
    const filename = shot?.media?.filename || path.basename(sourceVideoPath);
    const prepared = await prepareVideoForAnalysis(sourceVideoPath, filename);
    if (prepared.ok === false || !prepared.path) {
      return res.status(400).json({
        ok: false,
        message: `video preparation failed: ${prepared.error || 'prepared input unavailable'}`,
      });
    }
    inputPath = prepared.path;
  }
  const bodyPath = bodyArtifactPath(jobId);
  const url = inferUrl('/v1/labs/club-preprocess');
  if (!url) {
    return res.status(500).json({ ok: false, message: 'infer service not configured' });
  }
  const response = await inferFetchJson(url, {
    method: 'POST',
    body: {
      jobId,
      inputPath,
      bodyPath: fs.existsSync(bodyPath) ? bodyPath : null,
    },
    timeoutMs: 360_000,
  });
  if (!response.ok) {
    const inferredMessage =
      response.json?.detail?.error ||
      response.json?.error ||
      response.json?.message ||
      response.error?.message;
    return res.status(response.status || 500).json({
      ok: false,
      errorCode: response.status ? `LAB_INFER_HTTP_${response.status}` : 'LAB_INFER_UNREACHABLE',
      message: inferredMessage || `club preprocessing lab failed (infer HTTP ${response.status || 'unreachable'})`,
    });
  }
  const archive = await queueLabNasArchive({
    jobId,
    inputPath,
    sourceVideoPath,
    bodyPath: fs.existsSync(bodyPath) ? bodyPath : null,
    labResult: response.json,
  });
  return res.json({ ...response.json, archive });
});

app.post('/api/debug/infer/:jobId/debug-meta', async (req, res) => {
  const jobId = req.params.jobId;
  if (!isSafeJobId(jobId)) {
    return res.status(400).json({ ok: false, message: 'Invalid jobId' });
  }
  const url = cameraUrl('/api/meta/from-file');
  if (!url) {
    return res.status(500).json({ ok: false, message: 'camera service not configured' });
  }
  const shot = shotStore.getShotByJobId(jobId);
  const videoPath = resolveDebugVideoPath(jobId);
  if (!videoPath) {
    return res.status(404).json({ ok: false, message: 'video not found', jobId });
  }
  const filename = shot?.media?.filename || path.basename(videoPath);
  const prepared = await prepareVideoForAnalysis(videoPath, filename);
  if (prepared.ok === false) {
    return res.status(400).json({
      ok: false,
      message: `video preparation failed: ${prepared.error}`,
      codec: prepared.codec ?? null,
    });
  }
  const inputPath = prepared.path || videoPath;
  const videoMeta = await getVideoMeta(inputPath);
  const response = await inferFetchJson(url, {
    method: 'POST',
    body: {
      jobId,
      filename,
      inputPath,
      model: 'yolov8n_service7',
      force: true,
      debugDetections: true,
      durationSec:
        Number.isFinite(videoMeta?.durationMs) && videoMeta.durationMs > 0
          ? videoMeta.durationMs / 1000
          : undefined,
      durationMs: videoMeta?.durationMs,
      width: videoMeta?.width,
      height: videoMeta?.height,
      fps: videoMeta?.fps,
    },
    timeoutMs: 180_000,
  });
  if (!response.ok) {
    return res.status(response.status || 500).json({
      ok: false,
      message:
        response.json?.error ||
        response.json?.message ||
        response.error?.message ||
        'debug meta generation failed',
      status: response.status,
      responseBodySnippet: response.textSnippet || null,
    });
  }
  return res.json({
    ok: true,
    jobId,
    metaPath: response.json?.metaPath || null,
    debugMetaPath: response.json?.debugMetaPath || null,
    inputPath,
    converted: prepared.converted === true,
    conversion: prepared.conversion || null,
    cached: response.json?.cached === true,
  });
});

async function removeIfPresent(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.rm(filePath, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function removeJobArtifacts(jobId, cache) {
  if (!isSafeJobId(jobId)) return;
  const metaPaths = [
    resolveMetaPath(cache?.metaPath, jobId),
    resolveMetaPath(cache?.progress?.metaPath, jobId),
    resolveMetaPath(null, jobId),
    resolveMetaPath(path.join(metaDir, `${jobId}.debug.meta.json`), jobId),
  ];
  await Promise.all([
    removeIfPresent(analysisCachePath(jobId)),
    removeIfPresent(inferAnalysisPath(jobId)),
    removeIfPresent(bodyArtifactPath(jobId)),
    removeIfPresent(path.join(inferDebugFrameDir, jobId)),
    ...metaPaths.map(removeIfPresent),
  ]);
}

// Delete the uploaded video and every Pi/NAS artifact associated with its job.
app.delete('/api/files/:name', async (req, res) => {
  const target = resolveUploadPath(req.params.name);
  if (!target) {
    return res.status(400).json({ ok: false, message: 'Invalid file path' });
  }

  try {
    const shot = shotStore.getShotByMediaName(req.params.name);
    const jobId = shot?.jobId || path.basename(req.params.name, path.extname(req.params.name));
    if (!isSafeJobId(jobId)) return res.status(400).json({ ok: false, message: 'Invalid jobId' });
    const cache = readAnalysisCache(jobId);
    if (nasArchive.enabled) await nasArchive.deleteJob(jobId);
    await fs.promises.unlink(target);
    await removeJobArtifacts(jobId, cache);
    shotStore.removeShotByFilename(req.params.name);
    res.json({ ok: true, jobId });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ ok: false, message: 'File not found' });
    }
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Serve uploaded files statically; fallthrough false to avoid SPA fallback on 404
app.use('/uploads', express.static(uploadDir, { fallthrough: false }));
app.use('/debug', express.static(debugDir, { fallthrough: false }));
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
  if (err instanceof multer.MulterError) return res.status(400).json({ ok: false, message: '업로드 항목을 확인해 주세요.' });
  console.error(err);
  res.status(500).json({ ok: false, message: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Swing server listening on port ${PORT}`);
  setImmediate(resumeNasArchiveQueue);
  setImmediate(reconcileAnalysisQueue);
  setImmediate(syncNasDeletions);
  const analysisReconcileTimer = setInterval(reconcileAnalysisQueue, 10 * 1000);
  analysisReconcileTimer.unref?.();
  const nasDeletionTimer = setInterval(syncNasDeletions, 5 * 60 * 1000);
  nasDeletionTimer.unref?.();
});
