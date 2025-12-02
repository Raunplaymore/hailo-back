const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');

const pythonWorkerPath = path.join(__dirname, 'opencv_worker.py');

// Build a normalized frame sequence descriptor. This is a placeholder for
// future OpenCV-based extraction.
function buildFrameSequenceFromFile(filePath, meta = {}) {
  return {
    id: randomUUID(),
    sourceType: 'upload',
    path: path.resolve(filePath),
    fps: meta.fps ? Number(meta.fps) : undefined,
    camera: meta.cameraConfig || {},
    roi: meta.roi,
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
    backswing_time_ms: 0,
    downswing_time_ms: 0,
    tempo_ratio: 0,
    acceleration_rate: 0,
    max_clubhead_speed_frame_index: 0,
    head_movement: { horizontal: 0, vertical: 0 },
    upper_body_tilt_change: 0,
    shoulder_angle_at_address: 0,
    shoulder_angle_at_impact: 0,
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

async function runPythonAnalysis(frameSeq) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [pythonWorkerPath]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || `python worker exited with ${code}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(err);
      }
    });
    proc.stdin.write(
      JSON.stringify({
        path: frameSeq.path,
        fps: frameSeq.fps,
        roi: frameSeq.roi,
      }),
    );
    proc.stdin.end();
  });
}

async function analyzeFrameSequence(frameSeq) {
  // Try python worker first; fallback to stubs on error
  try {
    const result = await runPythonAnalysis(frameSeq);
    return result;
  } catch (err) {
    console.warn('Python analysis failed, falling back to stub:', err.message);
    const swing = swingAnalysis(frameSeq);
    const ballFlight = ballFlightAnalysis(frameSeq);
    const shot_type = shotTypeClassifier({ swing, ballFlight });
    const coach_summary = coachSummaryGenerator({ swing, ballFlight, shotType: shot_type });
    return { swing, ballFlight, shot_type, coach_summary };
  }
}

module.exports = {
  buildFrameSequenceFromFile,
  analyzeFrameSequence,
  swingAnalysis,
  ballFlightAnalysis,
  shotTypeClassifier,
  coachSummaryGenerator,
};
