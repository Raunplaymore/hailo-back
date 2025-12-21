const { analyzeFrameSequence } = require('../analysis/engine');

const ANALYSIS_VERSION = 'opencv-v1';

async function analyze(frameSeq) {
  const startedAt = Date.now();
  const result = await analyzeFrameSequence(frameSeq);
  const durationMs = Date.now() - startedAt;
  return {
    analysisVersion: ANALYSIS_VERSION,
    durationMs,
    raw: result,
  };
}

module.exports = {
  ANALYSIS_VERSION,
  analyze,
};
