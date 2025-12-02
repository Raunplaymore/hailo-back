const path = require('path');
const { randomUUID } = require('crypto');

// Build a normalized frame sequence descriptor. This is a placeholder for
// future OpenCV-based extraction.
function buildFrameSequenceFromFile(filePath, meta = {}) {
  return {
    id: randomUUID(),
    sourceType: 'upload',
    path: path.resolve(filePath),
    fps: meta.fps ? Number(meta.fps) : undefined,
    camera: meta.cameraConfig || {},
    frames: [], // TODO: populate with extracted frames when analysis is implemented
  };
}

// Stub swing analysis metrics
function swingAnalysis(_frameSeq) {
  return {
    club_path_angle: 0,
    downswing_path_curve: 0,
    shaft_forward_lean_at_impact: 0,
    shaft_angle_change_rate: 0,
    on_plane_ratio: 0,
    plane_deviation_std: 0,
  };
}

// Stub ball flight metrics
function ballFlightAnalysis(_frameSeq) {
  return {
    vertical_launch_angle: 0,
    horizontal_launch_direction: 0,
    initial_velocity: 0,
    spin_bias: 'neutral',
    side_curve_intensity: 0,
    apex_height_relative: 0,
    side_deviation: 0,
    projected_carry_distance: 0,
  };
}

function shotTypeClassifier({ swing, ballFlight }) {
  if (!swing || !ballFlight) return 'unknown';
  return 'straight';
}

function coachSummaryGenerator({ swing, ballFlight, shotType }) {
  return [
    `Shot classified as ${shotType}`,
    `Path angle ${swing?.club_path_angle ?? 0}°, launch ${ballFlight?.vertical_launch_angle ?? 0}°`,
  ];
}

module.exports = {
  buildFrameSequenceFromFile,
  swingAnalysis,
  ballFlightAnalysis,
  shotTypeClassifier,
  coachSummaryGenerator,
};
