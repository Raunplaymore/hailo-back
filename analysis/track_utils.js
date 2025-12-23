const BALL_LABELS = ['golf_ball', 'golfball', 'golf ball', 'ball'];
const CLUB_LABELS = ['clubhead', 'club_head', 'club-head', 'club head', 'club'];

const BALL_CLASS_ID = Number.parseInt(process.env.BALL_CLASS_ID, 10);
const CLUB_CLASS_ID = Number.parseInt(process.env.CLUB_CLASS_ID, 10);
const HAS_BALL_CLASS_ID = Number.isFinite(BALL_CLASS_ID);
const HAS_CLUB_CLASS_ID = Number.isFinite(CLUB_CLASS_ID);

function normalizeLabel(label) {
  if (!label) return '';
  return String(label).toLowerCase();
}

function matchesLabel(label, candidates) {
  if (!label) return false;
  return candidates.some((candidate) => label === candidate || label.includes(candidate));
}

function matchesClassId(det, targetId) {
  if (!Number.isFinite(targetId)) return false;
  if (!det || det.classId === null || det.classId === undefined) return false;
  return Number(det.classId) === targetId;
}

function isBallDetection(det) {
  const label = normalizeLabel(det?.label);
  return (
    matchesLabel(label, BALL_LABELS) ||
    (HAS_BALL_CLASS_ID && matchesClassId(det, BALL_CLASS_ID))
  );
}

function isClubheadDetection(det) {
  const label = normalizeLabel(det?.label);
  return (
    matchesLabel(label, CLUB_LABELS) ||
    (HAS_CLUB_CLASS_ID && matchesClassId(det, CLUB_CLASS_ID))
  );
}

function bboxCenter(bbox) {
  if (!bbox) return null;
  const x = Number(bbox.x);
  const y = Number(bbox.y);
  const w = Number(bbox.w);
  const h = Number(bbox.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return { x: x + w / 2, y: y + h / 2 };
}

function selectBestDetection(detections, predicate) {
  if (!Array.isArray(detections)) return null;
  let best = null;
  let bestScore = -1;
  for (const det of detections) {
    if (!predicate(det)) continue;
    const score = Number.isFinite(det.conf) ? det.conf : 0;
    if (!best || score > bestScore) {
      best = det;
      bestScore = score;
    }
  }
  return best;
}

function buildTrack(frames, predicate) {
  const track = [];
  for (const frame of frames || []) {
    const detections = frame?.detections || [];
    const best = selectBestDetection(detections, predicate);
    if (!best) continue;
    const center = bboxCenter(best.bbox);
    if (!center) continue;
    const t = Number.isFinite(frame.t)
      ? frame.t
      : Number.isFinite(frame.frame)
        ? frame.frame * (1000 / 30)
        : null;
    if (!Number.isFinite(t)) continue;
    track.push({
      t,
      frame: Number.isFinite(frame.frame) ? frame.frame : null,
      x: center.x,
      y: center.y,
      conf: Number.isFinite(best.conf) ? best.conf : null,
    });
  }
  return track;
}

function inferNormalized(points) {
  let maxValue = 0;
  for (const point of points || []) {
    if (!point) continue;
    maxValue = Math.max(maxValue, Math.abs(point.x), Math.abs(point.y));
  }
  return maxValue > 0 && maxValue <= 1.5;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  buildTrack,
  isBallDetection,
  isClubheadDetection,
  inferNormalized,
  clamp,
};
