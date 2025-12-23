const {
  buildTrack,
  isBallDetection,
  isClubheadDetection,
  inferNormalized,
} = require('./track_utils');

function detectImpactFromTrack(track, { distanceThreshold, speedThreshold }) {
  if (!track || track.length < 2) return null;
  let best = null;
  for (let i = 1; i < track.length; i += 1) {
    const prev = track[i - 1];
    const curr = track[i];
    const dt = curr.t - prev.t;
    if (!Number.isFinite(dt) || dt <= 0) continue;
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dist = Math.hypot(dx, dy);
    const speed = dist / dt;
    if (dist >= distanceThreshold || speed >= speedThreshold) {
      return { ...curr, speed };
    }
    if (!best || speed > best.speed) {
      best = { ...curr, speed };
    }
  }
  if (best && best.speed >= speedThreshold) return best;
  return null;
}

function detectEvents(frames) {
  const clubTrack = buildTrack(frames, isClubheadDetection);
  const ballTrack = buildTrack(frames, isBallDetection);
  const hasBall = ballTrack.length >= 2;
  const hasClub = clubTrack.length >= 2;

  const normalized = inferNormalized([...clubTrack, ...ballTrack]);
  const distanceThreshold = normalized ? 0.04 : 8;
  const speedThreshold = normalized ? 0.0008 : 0.02;

  let impact = null;
  let impactSource = 'none';
  if (hasBall) {
    impact = detectImpactFromTrack(ballTrack, { distanceThreshold, speedThreshold });
    if (impact) impactSource = 'ball';
  }
  if (!impact && hasClub) {
    impact = detectImpactFromTrack(clubTrack, {
      distanceThreshold: distanceThreshold * 2,
      speedThreshold,
    });
    if (impact) impactSource = 'club';
  }

  const addressMs = frames?.[0]?.t ?? null;
  const finishMs = frames?.[frames.length - 1]?.t ?? null;
  let topMs = null;
  if (clubTrack.length > 0) {
    const limit = impact?.t ?? Number.POSITIVE_INFINITY;
    let best = null;
    for (const point of clubTrack) {
      if (point.t > limit) continue;
      if (!best || point.y < best.y) {
        best = point;
      }
    }
    topMs = best?.t ?? null;
  }

  return {
    events: {
      addressMs: Number.isFinite(addressMs) ? Math.round(addressMs) : null,
      topMs: Number.isFinite(topMs) ? Math.round(topMs) : null,
      impactMs: Number.isFinite(impact?.t) ? Math.round(impact.t) : null,
      finishMs: Number.isFinite(finishMs) ? Math.round(finishMs) : null,
    },
    signals: {
      hasBall,
      hasClub,
      impactSource,
    },
  };
}

module.exports = {
  detectEvents,
};
