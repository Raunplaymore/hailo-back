const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 'swing-tracking-label-v2';
const EVENT_KEYS = ['address', 'takeaway', 'top', 'impact', 'finish'];
const POINT_KEYS = ['clubHead', 'clubHandle'];
const VIEWPOINTS = new Set(['unknown', 'down_the_line', 'face_on']);
const HANDEDNESS = new Set(['unknown', 'right', 'left']);
const STATUSES = new Set(['draft', 'reviewed']);
const VISIBILITIES = new Set(['visible', 'occluded', 'out_of_frame', 'unknown']);

function thumbnailUrl(dataDir, jobId) {
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(jobId)) return null;
  const thumbnailPath = path.join(dataDir, 'debug', 'nas-thumbnails', `${jobId}.jpg`);
  return fs.existsSync(thumbnailPath)
    ? `/debug/nas-thumbnails/${encodeURIComponent(jobId)}.jpg`
    : null;
}

function validateAnnotationIdentity(jobId, input) {
  const source = input && typeof input === 'object' ? input : {};
  if (typeof source.jobId === 'string' && source.jobId !== jobId) {
    return {
      code: 'ANNOTATION_JOB_MISMATCH',
      message: 'Annotation jobId does not match the requested jobId',
    };
  }
  const metaPath = source.source?.metaPath;
  if (typeof metaPath === 'string' && metaPath) {
    const metaFile = path.basename(metaPath);
    const validMetaFiles = new Set([`${jobId}.meta.json`, `${jobId}.debug.meta.json`]);
    if (!validMetaFiles.has(metaFile)) {
      return {
        code: 'ANNOTATION_SOURCE_MISMATCH',
        message: 'Annotation metaPath belongs to a different jobId',
      };
    }
  }
  return null;
}

function finiteNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizePoint(value) {
  if (!value || typeof value !== 'object') return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  if (x === null || y === null || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return {
    x: Math.round(x * 1_000_000) / 1_000_000,
    y: Math.round(y * 1_000_000) / 1_000_000,
    source: ['manual', 'model'].includes(value.source) ? value.source : 'unknown',
  };
}

function sanitizeFrameLabel(value) {
  if (!value || typeof value !== 'object') return null;
  const frame = finiteNumber(value.frame);
  const timeMs = finiteNumber(value.timeMs);
  if (frame === null || frame < 0 || timeMs === null || timeMs < 0) return null;
  const result = {
    frame: Math.round(frame),
    timeMs: Math.round(timeMs),
  };
  for (const key of POINT_KEYS) {
    const point = sanitizePoint(value[key]);
    const visibilityKey = `${key}Visibility`;
    const requestedVisibility = VISIBILITIES.has(value[visibilityKey])
      ? value[visibilityKey]
      : 'unknown';
    if (point) {
      result[key] = point;
      result[visibilityKey] = 'visible';
    } else if (requestedVisibility !== 'unknown' && requestedVisibility !== 'visible') {
      result[visibilityKey] = requestedVisibility;
    }
  }
  return (
    result.clubHead ||
    result.clubHandle ||
    result.clubHeadVisibility ||
    result.clubHandleVisibility
  ) ? result : null;
}

function sanitizeEvent(value) {
  if (!value || typeof value !== 'object') return null;
  const frame = finiteNumber(value.frame);
  const timeMs = finiteNumber(value.timeMs);
  if (frame === null || frame < 0 || timeMs === null || timeMs < 0) return null;
  return {
    frame: Math.round(frame),
    timeMs: Math.round(timeMs),
    source: ['manual', 'analysis'].includes(value.source) ? value.source : 'unknown',
  };
}

function sanitizeAnnotation(jobId, input) {
  const source = input && typeof input === 'object' ? input : {};
  const frameLabels = Array.isArray(source.frames)
    ? source.frames.map(sanitizeFrameLabel).filter(Boolean).sort((a, b) => a.frame - b.frame)
    : [];
  const dedupedFrames = [...new Map(frameLabels.map((frame) => [frame.frame, frame])).values()];
  const events = {};
  for (const key of EVENT_KEYS) {
    events[key] = sanitizeEvent(source.events?.[key]);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    jobId,
    viewpoint: VIEWPOINTS.has(source.viewpoint) ? source.viewpoint : 'unknown',
    handedness: HANDEDNESS.has(source.handedness) ? source.handedness : 'unknown',
    status: STATUSES.has(source.status) ? source.status : 'draft',
    events,
    frames: dedupedFrames,
    notes: typeof source.notes === 'string' ? source.notes.slice(0, 4000) : '',
    source: {
      variant: source.source?.variant === 'debug' ? 'debug' : 'main',
      analysisVersion: typeof source.source?.analysisVersion === 'string'
        ? source.source.analysisVersion.slice(0, 120)
        : null,
      metaPath: typeof source.source?.metaPath === 'string'
        ? source.source.metaPath.slice(0, 1000)
        : null,
    },
  };
}

function createSwingTrackingAnnotationStore({ dataDir }) {
  const annotationDir = path.join(dataDir, 'annotations', 'swing-tracking');
  // shortcut: this queue protects one store instance; use a shared lock if multiple writers are introduced.
  const pendingSaves = new Map();
  fs.mkdirSync(annotationDir, { recursive: true });

  function annotationPath(jobId) {
    return path.join(annotationDir, `${jobId}.json`);
  }

  async function load(jobId) {
    try {
      return JSON.parse(await fs.promises.readFile(annotationPath(jobId), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  function save(jobId, input) {
    const previous = pendingSaves.get(jobId) || Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      const current = await load(jobId);
      const currentVersion = typeof current?.updatedAt === 'string' ? current.updatedAt : null;
      const submittedVersion = typeof input?.updatedAt === 'string' ? input.updatedAt : null;
      const invalidVersion = (current?.updatedAt != null && typeof current.updatedAt !== 'string')
        || (input?.updatedAt != null && typeof input.updatedAt !== 'string');
      const normalized = sanitizeAnnotation(jobId, input);
      if (invalidVersion || currentVersion !== submittedVersion) {
        // Identical content can be a retry after the save response was lost.
        if (!invalidVersion && current && JSON.stringify(normalized) === JSON.stringify(sanitizeAnnotation(jobId, current))) return current;
        const error = new Error('저장된 라벨이 변경되어 저장하지 못했습니다. 다른 화면에서 저장했거나 이전 저장 응답이 끊겼을 수 있어요. 현재 편집 내용은 이 화면에 남아 있으니 기록한 후 최신 라벨을 불러와 주세요.');
        error.code = 'ANNOTATION_CHANGED';
        throw error;
      }
      const previousTime = Date.parse(currentVersion || '');
      // The timestamp is also the version and must advance even within one millisecond.
      const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
      const annotation = { ...normalized, updatedAt };
      const targetPath = annotationPath(jobId);
      const temporaryPath = `${targetPath}.${process.pid}.tmp`;
      await fs.promises.writeFile(temporaryPath, `${JSON.stringify(annotation, null, 2)}\n`, 'utf8');
      await fs.promises.rename(temporaryPath, targetPath);
      return annotation;
    });
    pendingSaves.set(jobId, work);
    const clear = () => { if (pendingSaves.get(jobId) === work) pendingSaves.delete(jobId); };
    void work.then(clear, clear);
    return work;
  }

  async function list() {
    const entries = await fs.promises.readdir(annotationDir, { withFileTypes: true });
    const annotations = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        try {
          const annotation = JSON.parse(
            await fs.promises.readFile(path.join(annotationDir, entry.name), 'utf8')
          );
          const events = EVENT_KEYS.filter((key) => annotation.events?.[key]).length;
          return {
            jobId: annotation.jobId || entry.name.slice(0, -5),
            status: STATUSES.has(annotation.status) ? annotation.status : 'draft',
            viewpoint: VIEWPOINTS.has(annotation.viewpoint) ? annotation.viewpoint : 'unknown',
            handedness: HANDEDNESS.has(annotation.handedness) ? annotation.handedness : 'unknown',
            labeledFrames: Array.isArray(annotation.frames) ? annotation.frames.length : 0,
            events,
            updatedAt: typeof annotation.updatedAt === 'string' ? annotation.updatedAt : null,
            thumbnailUrl: thumbnailUrl(dataDir, annotation.jobId || entry.name.slice(0, -5)),
          };
        } catch {
          return null;
        }
      }));
    return annotations
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  return {
    annotationDir,
    list,
    load,
    save,
  };
}

module.exports = {
  SCHEMA_VERSION,
  createSwingTrackingAnnotationStore,
  sanitizeAnnotation,
  validateAnnotationIdentity,
};
