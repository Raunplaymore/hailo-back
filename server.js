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

const app = express();
const PORT = 3000;
// Default to local uploads directory; allow override for Raspberry Pi via env
const uploadDir =
  process.env.UPLOAD_DIR ||
  (fs.existsSync('/home/ray/uploads') ? '/home/ray/uploads' : path.join(__dirname, 'uploads'));
const dataDir =
  process.env.DATA_DIR ||
  (fs.existsSync('/home/ray/data') ? '/home/ray/data' : path.join(__dirname, 'data'));
const metaDir = process.env.META_DIR || '/tmp';
const healthDir = path.join(__dirname, 'health');
const inferBaseUrl = process.env.INFER_BASE_URL || 'http://127.0.0.1:3002';
const cameraBaseUrl = process.env.CAMERA_BASE_URL || 'http://127.0.0.1:3001';
const bodyAnalyzerBaseUrl = process.env.BODY_ANALYZER_BASE_URL || inferBaseUrl;
const analysisCacheDir = path.join(dataDir, 'analysis');

// Ensure upload directory exists
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(analysisCacheDir, { recursive: true });
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
      swingPlane,
      impactStability,
    },
    pending: DEFAULT_PENDING_ITEMS,
    summary,
    coachSummary,
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

function bodyArtifactPath(jobId) {
  if (!jobId) return null;
  return path.join(dataDir, 'body', `${jobId}.json`);
}

function readAnalysisCache(jobId) {
  const cachePath = analysisCachePath(jobId);
  if (!cachePath) return null;
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
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

function writeAnalysisCache(jobId, cache) {
  const cachePath = analysisCachePath(jobId);
  if (!cachePath || !cache) return null;
  const payload = {
    jobId,
    ...cache,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
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
    confidence: result?.confidence ?? null,
    meta: result?.meta ?? null,
    progress: result?.progress ?? null,
  };
}

function isJobAnalysisPayload(result) {
  return Boolean(result?.metrics?.ball) && Boolean(result?.events);
}

function normalizeInferResult(jobId, status, result) {
  if (!result || typeof result !== 'object') {
    return buildCoachAnalysisPayload(jobId, status, {});
  }
  if (result.analysis && typeof result.analysis === 'object') {
    return normalizeInferResult(jobId, status, result.analysis);
  }
  if (isJobAnalysisPayload(result)) {
    const mappedStatus =
      status === 'done'
        ? 'succeeded'
        : status === 'failed'
        ? 'failed'
        : status === 'running'
        ? 'running'
        : result.status === 'done'
        ? 'succeeded'
        : result.status === 'failed'
        ? 'failed'
        : result.status;
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
      confidence: result.confidence ?? null,
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

function buildInferErrorAnalysis(jobId, errorMessage) {
  return {
    jobId,
    status: 'failed',
    analysisVersion: 'coach-meta-v1',
    errorCode: 'INFER_UNAVAILABLE',
    events: {
      address: null,
      top: null,
      impact: null,
      finish: null,
    },
    metrics: {
      tempo: { backswingMs: null, downswingMs: null, ratio: null },
      eventTiming: { address: null, top: null, impact: null, finish: null },
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

function buildQueuedUploadShot(file, body) {
  const existing = shotStore.getShotByMediaName(file.filename);
  const sourceType = body.sourceType || existing?.sourceType || 'upload';
  const jobId = existing?.jobId || randomUUID();
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
    club: body.club,
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
      filename: file.filename,
      path: file.path,
      size: file.size,
    },
    metadata: {
      ...metadata,
      metaPath: resolveMetaPath(body.metaPath, jobId) || undefined,
    },
    analysis: existing?.analysis ?? null,
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

function queueUploadedShotAnalysis(file, body) {
  const queuedShot = buildQueuedUploadShot(file, body);
  setImmediate(() => {
    analyzeAndStoreUploadedShot(file, body).catch((err) => {
      console.error('queued upload analysis failed', err);
      markQueuedUploadShotFailed(file, err.message || 'Analysis failed');
    });
  });
  return queuedShot;
}

async function analyzeAndStoreUploadedShot(file, body) {
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
    club: body.club,
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
          fusionPath: submitResult.status === 'done' ? analysisCachePath(jobId) : null,
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
  const prepared = await prepareVideoForAnalysis(file.path, file.filename);
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
          fusionPath: submitResult.status === 'done' ? analysisCachePath(jobId) : null,
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
  if (!resolveUploadPath(targetFilename)) {
    return res.status(400).json({ ok: false, message: 'Invalid file path' });
  }
  const resolvedMetaPath = resolveMetaPath(metaPathInput, providedJobId);
  if (!resolvedMetaPath) {
    return res.status(400).json({ ok: false, message: 'Invalid meta path' });
  }
  let progress = buildGroupedProgress('club_ready', {
    analysisPath: 'infer',
    metaPath: resolvedMetaPath,
    clubPath: resolvedMetaPath,
  });

  const cached = readAnalysisCache(providedJobId);
  const cachedAgeMs = cached?.updatedAt ? Date.now() - Date.parse(cached.updatedAt) : Number.POSITIVE_INFINITY;
  const hasFreshInFlightCache =
    Number.isFinite(cachedAgeMs) &&
    cachedAgeMs < 30_000 &&
    (cached.status === 'pending' || cached.status === 'running');
  if (!force && cached?.status && (cached.status === 'done' || hasFreshInFlightCache)) {
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

  const videoPath = path.join(uploadDir, targetFilename);
  const requestBody = {
    mode: 'coach_from_meta',
    jobId: providedJobId,
    source: {
      filename: targetFilename,
      videoPath,
      metaPath: resolvedMetaPath,
    },
    options: { force: Boolean(force) },
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
    fusionPath: submitResult.status === 'done' ? analysisCachePath(providedJobId) : null,
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
  const shot = shotStore.getShotByJobId(jobId);
  const shotProgress = shot?.progress || null;
  const shotMetadata = shot?.metadata || null;
  const diskBodyPath = bodyArtifactPath(jobId);
  const diskBodyExists = typeof diskBodyPath === 'string' && fs.existsSync(diskBodyPath);
  const cachedStatus = cached?.status;
  const cachedAnalysis = cached?.analysis || null;
  const cachedProgress = cached?.progress || null;
  const cachedMetaPath =
    cachedProgress?.metaPath || cached?.metaPath || shotProgress?.metaPath || shotMetadata?.metaPath || null;
  const cachedBodyPath =
    cachedProgress?.bodyPath ||
    shotProgress?.bodyPath ||
    shotMetadata?.bodyPath ||
    (diskBodyExists ? diskBodyPath : null);
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
    writeAnalysisCache(jobId, {
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
    writeAnalysisCache(jobId, {
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
      fusionPath: mappedStatus === 'done' ? cachedFusionPath || analysisCachePath(jobId) : cachedFusionPath,
      detail: cachedDetail,
    },
  );

  if (mappedStatus === 'done' || mappedStatus === 'failed') {
    const resultUrl = inferUrl(`/v1/jobs/${encodeURIComponent(jobId)}/result`);
    if (resultUrl) {
      const resultRes = await inferFetchJson(resultUrl, { timeoutMs: 3000 });
      if (resultRes.ok) {
        analysis = normalizeInferResult(jobId, mappedStatus, resultRes.json);
        progress = buildGroupedProgress(mappedStatus === 'done' ? 'fusion_succeeded' : 'failed', {
          analysisPath: 'infer',
          metaPath: cachedMetaPath,
          bodyPath: cachedBodyPath,
          clubPath: cachedClubPath,
          fusionPath: mappedStatus === 'done' ? cachedFusionPath || analysisCachePath(jobId) : cachedFusionPath,
          message: mappedStatus === 'failed' ? analysis?.errorMessage || PROGRESS_STAGE_META.failed.message : undefined,
          detail: cachedDetail,
        });
        if (analysis && typeof analysis === 'object') {
          analysis.progress = progress;
        }
      } else if (!analysis) {
        const errorAnalysis = buildInferErrorAnalysis(jobId, 'infer result unavailable');
        progress = buildAnalysisProgress('failed', {
          analysisPath: 'infer',
          metaPath: cached?.metaPath || null,
          message: 'infer result unavailable',
        });
        writeAnalysisCache(jobId, {
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
    writeAnalysisCache(jobId, {
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
  writeAnalysisCache(jobId, {
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

app.get('/api/analyze/:jobId', respondJobStatus);
app.get('/api/analyze/:jobId/result', respondJobResult);

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
        const derivedJobId = path.basename(filename, path.extname(filename));
        const cached = readAnalysisCache(derivedJobId);
        const cachedAnalysis = cached?.analysis || null;
        const cachedStatus = cached?.status || null;
        const cachedFileStatus = cachedStatus ? mapCacheStatusToFileStatus(cachedStatus) : null;
        const cachedAnalyzed = cachedStatus === 'done';
        let stats;
        try {
          stats = await fs.promises.stat(path.join(uploadDir, filename));
        } catch {
          // ignore stat errors; keep lightweight listing
        }
        const errorCode =
          shot?.analysis?.errorCode ??
          cachedAnalysis?.errorCode ??
          cached?.errorCode ??
          null;
        const errorMessage =
          shot?.analysis?.errorMessage ??
          cachedAnalysis?.errorMessage ??
          cached?.errorMessage ??
          null;
        return {
          filename,
          url: uploadsUrl(filename),
          shotId: shot?.id || null,
          jobId: shot?.jobId || cached?.jobId || derivedJobId,
          analyzed:
            normalizeJobStatus(shot?.status) === 'succeeded' ||
            (!shot && cachedAnalyzed),
          status:
            normalizeJobStatus(shot?.status) ||
            (shot?.analysis
              ? (looksLikeAnalysisFailure(shot.analysis) ? 'failed' : 'succeeded')
              : cachedFileStatus || 'not-analyzed'),
          errorCode,
          errorMessage,
          metaPath: cached?.metaPath || null,
          size: stats?.size,
          modifiedAt: stats?.mtime?.toISOString(),
          analysis: shot ? buildJobAnalysisPayload(shot) : cachedAnalysis,
          progress: shot?.progress || cached?.progress || null,
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
