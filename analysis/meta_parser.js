const DEFAULT_FPS = 30;

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeBbox(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    if (raw.length < 4) return null;
    const a = toNumber(raw[0]);
    const b = toNumber(raw[1]);
    const c = toNumber(raw[2]);
    const d = toNumber(raw[3]);
    if (![a, b, c, d].every(Number.isFinite)) return null;
    if (c > a && d > b) {
      const w = c - a;
      const h = d - b;
      if (w <= 0 || h <= 0) return null;
      return { x: a, y: b, w, h };
    }
    if (c <= 0 || d <= 0) return null;
    return { x: a, y: b, w: c, h: d };
  }
  if (typeof raw === 'object') {
    const x = toNumber(raw.x ?? raw.left ?? raw.xmin ?? raw.x1 ?? raw.start_x);
    const y = toNumber(raw.y ?? raw.top ?? raw.ymin ?? raw.y1 ?? raw.start_y);
    const w = toNumber(raw.w ?? raw.width ?? raw.wd);
    const h = toNumber(raw.h ?? raw.height ?? raw.ht);
    if ([x, y, w, h].every(Number.isFinite)) {
      if (w <= 0 || h <= 0) return null;
      return { x, y, w, h };
    }
    const right = toNumber(raw.right ?? raw.xmax ?? raw.x2 ?? raw.end_x);
    const bottom = toNumber(raw.bottom ?? raw.ymax ?? raw.y2 ?? raw.end_y);
    if ([x, y, right, bottom].every(Number.isFinite)) {
      const w2 = right - x;
      const h2 = bottom - y;
      if (w2 <= 0 || h2 <= 0) return null;
      return { x, y, w: w2, h: h2 };
    }
  }
  return null;
}

function normalizeDetection(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bbox = normalizeBbox(
    raw.bbox ||
      raw.box ||
      raw.rect ||
      raw.bounding_box ||
      raw.boundingBox ||
      raw.boundingBox2d ||
      (raw.x !== undefined || raw.y !== undefined
        ? { x: raw.x, y: raw.y, w: raw.w ?? raw.width, h: raw.h ?? raw.height }
        : null),
  );
  if (!bbox) return null;
  const label = raw.label ?? raw.class ?? raw.class_name ?? raw.name ?? raw.category;
  const classId = toNumber(raw.classId ?? raw.class_id ?? raw.id);
  const conf = toNumber(raw.conf ?? raw.confidence ?? raw.score ?? raw.prob ?? raw.probability);
  return {
    label: label ? String(label) : null,
    classId: Number.isFinite(classId) ? classId : null,
    conf: Number.isFinite(conf) ? conf : null,
    bbox,
  };
}

function normalizeDetections(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map(normalizeDetection).filter(Boolean);
  }
  if (raw.detections) return normalizeDetections(raw.detections);
  if (raw.objects) return normalizeDetections(raw.objects);
  if (raw.results) return normalizeDetections(raw.results);
  if (Array.isArray(raw.boxes)) {
    const boxes = raw.boxes;
    const scores = Array.isArray(raw.scores) ? raw.scores : [];
    const classes = Array.isArray(raw.classes) ? raw.classes : [];
    const labels = Array.isArray(raw.labels) ? raw.labels : [];
    return boxes
      .map((box, idx) =>
        normalizeDetection({
          bbox: box,
          conf: scores[idx],
          classId: classes[idx],
          label: labels[classes[idx]],
        }),
      )
      .filter(Boolean);
  }
  return [];
}

function normalizeTimestamp(raw, frameIndex, fps) {
  const t = toNumber(raw);
  if (Number.isFinite(t)) {
    return t < 1000 ? t * 1000 : t;
  }
  if (Number.isFinite(frameIndex) && Number.isFinite(fps) && fps > 0) {
    return (frameIndex / fps) * 1000;
  }
  if (Number.isFinite(frameIndex)) {
    return frameIndex * (1000 / DEFAULT_FPS);
  }
  return null;
}

function parseFrame(rawFrame, index, fps) {
  if (!rawFrame || typeof rawFrame !== 'object') return null;
  const frameIndex =
    toNumber(
      rawFrame.frame ??
        rawFrame.frame_id ??
        rawFrame.frameIndex ??
        rawFrame.frame_index ??
        rawFrame.index ??
        rawFrame.id,
    ) ?? index;
  const detections = normalizeDetections(
    rawFrame.detections ??
      rawFrame.objects ??
      rawFrame.dets ??
      rawFrame.results ??
      rawFrame.items ??
      rawFrame.predictions,
  );
  const t = normalizeTimestamp(
    rawFrame.t ??
      rawFrame.time ??
      rawFrame.timestamp ??
      rawFrame.ts ??
      rawFrame.time_ms ??
      rawFrame.timeMs ??
      rawFrame.time_s ??
      rawFrame.timeSec,
    frameIndex,
    fps,
  );
  return {
    t,
    frame: Number.isFinite(frameIndex) ? frameIndex : null,
    detections,
  };
}

function extractFrames(meta) {
  if (!meta) return [];
  if (Array.isArray(meta)) return meta;
  if (Array.isArray(meta.frames)) return meta.frames;
  if (Array.isArray(meta.results)) return meta.results;
  if (Array.isArray(meta.detections)) return meta.detections;
  return [];
}

function parseMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return { frames: [], fps: DEFAULT_FPS };
  }
  const fps =
    toNumber(meta.fps ?? meta.frameRate ?? meta.frame_rate ?? meta.framerate) ??
    DEFAULT_FPS;
  const rawFrames = extractFrames(meta);
  const frames = rawFrames
    .map((frame, index) => parseFrame(frame, index, fps))
    .filter(Boolean)
    .filter((frame) => Number.isFinite(frame.t));
  frames.sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0));
  return { frames, fps };
}

module.exports = {
  parseMeta,
};
