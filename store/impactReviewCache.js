const fs = require('fs');
const path = require('path');
const MODEL_SHA256 = '70b338b519565f870ed1fce044a0453f828773e53b9fa9d024391b3b4cf57733';

function createImpactReviewCache({ dataDir, run }) {
  const directory = path.join(dataDir, 'impact-review-results');
  const active = new Map();
  let tail = Promise.resolve();
  const safeId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  const read = (jobId) => {
    if (!safeId(jobId)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(directory, `${jobId}.json`), 'utf8')); }
    catch { return null; }
  };
  const schedule = (jobId, inputPath, bodyPath = null) => {
    if (!safeId(jobId)) return Promise.reject(new Error('Invalid jobId'));
    const source = path.resolve(inputPath);
    const stat = fs.statSync(source);
    if (!stat.isFile()) return Promise.reject(new Error('Video input is not a file'));
    const identity = { inputPath: source, size: stat.size, mtimeMs: stat.mtimeMs };
    const key = JSON.stringify([jobId, identity]);
    if (active.has(key)) return active.get(key);
    const cached = read(jobId);
    if (cached && cached.result?.modelSha256 === MODEL_SHA256 && cached.result?.timingRevision === 2
      && Object.keys(identity).every((k) => cached[k] === identity[k])) return Promise.resolve(cached.result);
    const work = tail.then(async () => {
      const result = await run(jobId, source, bodyPath);
      if (result?.ok !== true || result.status !== 'reference_candidate' || result.jobId !== jobId
        || result.modelSha256 !== MODEL_SHA256 || result.timingRevision !== 2 || result.publicValue !== null
        || result.automaticCoachingReady !== false || result.appliedToPrimary !== false
        || result.inputScopeConfirmed !== false) throw new Error('Invalid automatic impact candidate');
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `${jobId}.json`);
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ ...identity, result }));
      fs.renameSync(temp, file);
      return result;
    });
    active.set(key, work);
    tail = work.catch(() => undefined);
    work.then(() => active.delete(key), () => active.delete(key));
    return work;
  };
  return { read, schedule };
}
module.exports = { createImpactReviewCache };
