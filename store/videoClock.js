const fs = require('fs');
const path = require('path');
const { matchesVideoIdentity } = require('./impactReviewCache');

// Ephemeral clocks only; no impact candidate or training label is written.
function createVideoClock({ probe, hash }) {
  const ready = new Map();
  const active = new Map();
  let tail = Promise.resolve();
  const fields = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'];
  const read = (jobId, videoSha256) => {
    const entry = ready.get(jobId);
    return entry && entry.result.videoSha256 === videoSha256 ? entry : null;
  };
  const prepare = (jobId, inputPath) => {
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return Promise.reject(new Error('Invalid job'));
    const source = path.resolve(inputPath);
    const stat = fs.statSync(source);
    if (!stat.isFile()) return Promise.reject(new Error('Video input is not a file'));
    const identity = { inputPath: source, ...Object.fromEntries(fields.map(k => [k, stat[k]])) };
    const cached = ready.get(jobId);
    if (cached?.inputPath === source && matchesVideoIdentity(cached, stat)) return Promise.resolve(cached.result);
    const key = JSON.stringify([jobId, identity]);
    if (active.has(key)) return active.get(key);
    if (active.size >= 4) return Promise.reject(new Error('Video clock is busy'));
    const work = tail.then(async () => {
      const { times, frameCount } = await probe(source);
      if (!Array.isArray(times) || times.length < 4 || times.length > 7200 || frameCount !== times.length
          || times[0] !== 0 || !times.every((t, i) => Number.isFinite(t) && t >= 0 && t <= 30000 && (!i || t > times[i - 1]))) {
        throw new Error('Video frame clock unavailable');
      }
      const videoSha256 = await hash(source);
      if (!/^[a-f0-9]{64}$/.test(videoSha256) || !matchesVideoIdentity(identity, fs.statSync(source))) {
        throw new Error('Video changed while reading its clock');
      }
      const result = { ok: true, jobId, videoSha256, frameTimesMs: times, timingRevision: 3 };
      ready.delete(jobId);
      ready.set(jobId, { ...identity, result });
      if (ready.size > 32) ready.delete(ready.keys().next().value);
      return result;
    });
    active.set(key, work);
    tail = work.catch(() => undefined);
    work.then(() => active.delete(key), () => active.delete(key));
    return work;
  };
  return { read, prepare };
}

function selectVideoReference(impact, manual, videoSha256, { requireRevision3 = false } = {}) {
  for (const entry of [impact, manual]) {
    if (entry?.result?.videoSha256 !== videoSha256 || (requireRevision3 && entry.result.timingRevision !== 3)) continue;
    try { if (matchesVideoIdentity(entry, fs.statSync(entry.inputPath))) return entry; }
    catch { /* A missing or changed video is not a usable reference. */ }
  }
  return null;
}

module.exports = { createVideoClock, selectVideoReference };
