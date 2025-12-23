const {
  buildTrack,
  isClubheadDetection,
  inferNormalized,
  clamp,
} = require('./track_utils');

function computeTempo(events) {
  const addressMs = events?.addressMs;
  const topMs = events?.topMs;
  const impactMs = events?.impactMs;
  if (!Number.isFinite(addressMs) || !Number.isFinite(topMs) || !Number.isFinite(impactMs)) {
    return { backswingMs: null, downswingMs: null, ratio: null };
  }
  const backswingMs = Math.max(0, topMs - addressMs);
  const downswingMs = Math.max(0, impactMs - topMs);
  if (!backswingMs || !downswingMs) {
    return { backswingMs: null, downswingMs: null, ratio: null };
  }
  const ratio = Number((backswingMs / downswingMs).toFixed(2));
  return {
    backswingMs: Math.round(backswingMs),
    downswingMs: Math.round(downswingMs),
    ratio,
  };
}

function computeSwingPlane(track, impactMs) {
  if (!track || track.length < 2) {
    return { label: 'neutral', confidence: 0 };
  }
  let window = track;
  if (Number.isFinite(impactMs)) {
    window = track.filter((point) => Math.abs(point.t - impactMs) <= 250);
    if (window.length < 2) window = track;
  }
  window.sort((a, b) => a.t - b.t);
  const first = window[0];
  const last = window[window.length - 1];
  const dx = last.x - first.x;
  const normalized = inferNormalized(window);
  const threshold = normalized ? 0.02 : 6;

  let label = 'neutral';
  if (dx > threshold) label = 'inside-out';
  if (dx < -threshold) label = 'outside-in';

  const confidence = clamp(Math.abs(dx) / (threshold * 2), 0, 1);
  return {
    label,
    confidence: Number(confidence.toFixed(2)),
  };
}

function computeImpactStability(track, impactMs) {
  if (!track || track.length < 2) {
    return { label: 'unstable', score: 0 };
  }
  let window = track;
  if (Number.isFinite(impactMs)) {
    window = track.filter((point) => Math.abs(point.t - impactMs) <= 200);
    if (window.length < 2) window = track;
  }
  const mean = window.reduce(
    (acc, point) => {
      return { x: acc.x + point.x, y: acc.y + point.y };
    },
    { x: 0, y: 0 },
  );
  mean.x /= window.length;
  mean.y /= window.length;

  let varX = 0;
  let varY = 0;
  for (const point of window) {
    varX += (point.x - mean.x) ** 2;
    varY += (point.y - mean.y) ** 2;
  }
  varX /= window.length;
  varY /= window.length;
  const spread = Math.hypot(Math.sqrt(varX), Math.sqrt(varY));

  const normalized = inferNormalized(window);
  const reference = normalized ? 0.05 : 12;
  const score = clamp(1 - spread / reference, 0, 1);
  return {
    label: score >= 0.6 ? 'stable' : 'unstable',
    score: Number(score.toFixed(2)),
  };
}

function buildSummary(metrics, events, signals) {
  const parts = [];
  const notes = [];
  const swingPlane = metrics.swingPlane;
  if (swingPlane) {
    const confidenceNote = swingPlane.confidence < 0.4 ? ' (low confidence)' : '';
    parts.push(`Swing plane ${swingPlane.label}${confidenceNote}`);
  }
  if (metrics.impactStability) {
    parts.push(`Impact stability ${metrics.impactStability.label}`);
  }
  if (metrics.tempo?.ratio !== null && metrics.tempo?.ratio !== undefined) {
    parts.push(`Tempo ${metrics.tempo.ratio}:1`);
  } else {
    parts.push('Tempo unavailable');
  }
  if (!signals?.hasClub) notes.push('clubhead not detected');
  if (events?.impactMs === null || events?.impactMs === undefined) {
    notes.push('impact unknown');
  }
  let summary = `${parts.join('. ')}.`;
  if (notes.length) {
    summary += ` Notes: ${notes.join(', ')}.`;
  }
  return summary;
}

function calculateMetrics(frames, events, signals = {}) {
  const clubTrack = buildTrack(frames, isClubheadDetection);
  const swingPlane = computeSwingPlane(clubTrack, events?.impactMs);
  const tempo = computeTempo(events);
  const impactStability = computeImpactStability(clubTrack, events?.impactMs);
  const metrics = {
    swingPlane,
    tempo,
    impactStability,
  };
  const summary = buildSummary(metrics, events, { ...signals, hasClub: clubTrack.length > 0 || signals.hasClub });
  return { metrics, summary };
}

module.exports = {
  calculateMetrics,
};
