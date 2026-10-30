import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cacheModule from '../store/impactReviewCache.js';

const root = await mkdtemp(join(tmpdir(), 'impact-actual-pose-'));
const hash = 'a'.repeat(64), model = '70b338b519565f870ed1fce044a0453f828773e53b9fa9d024391b3b4cf57733';
const video = join(root, 'video.mp4');
await writeFile(video, 'synthetic video');
async function fixture(name) {
  const data = join(root, name), offered = join(data, 'offered.json');
  const fallback = join(data, 'impact-review', hash, 'body', 'pose.json');
  await mkdir(join(data, 'impact-review', hash, 'body'), { recursive: true });
  await writeFile(offered, '{'); await writeFile(fallback, JSON.stringify({ timeMs: 800 }));
  return { data, offered, fallback };
}
async function proof(file, kind) {
  const s = await stat(file, { bigint: true });
  const identity = [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String);
  return { version: 1, kind, statToken: createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
}
function candidate(jobId, timeMs, poseProvenance) {
  return { ok: true, jobId, status: 'reference_candidate', timingRevision: 3, modelSha256: model,
    videoSha256: hash, publicValue: null, automaticCoachingReady: false, appliedToPrimary: false,
    inputScopeConfirmed: false, candidate: { frameIndex: 1, timeMs }, poseProvenance };
}
try {
  const f = await fixture('fallback'); let calls = 0;
  const cache = cacheModule.createImpactReviewCache({ dataDir: f.data, run: async id => {
    calls++;
    return candidate(id, JSON.parse(await readFile(f.fallback, 'utf8')).timeMs, await proof(f.fallback, 'isolated'));
  }});
  const first = await cache.schedule('job', video, f.offered);
  assert.equal(first.candidate.timeMs, 800);
  const temp = join(f.data, 'new-pose.json'); await writeFile(temp, JSON.stringify({ timeMs: 1600 })); await rename(temp, f.fallback);
  assert.equal(cache.readCurrent('job', f.offered), null, 'changed actual fallback must invalidate the candidate');
  const second = await cache.schedule('job', video, f.offered);
  assert.equal(second.candidate.timeMs, 1600); assert.equal(calls, 2);
  assert.equal('poseProvenance' in second, false, 'internal file identity must not be exposed to the browser');
  const legacyPath = join(f.data, 'impact-review-results', 'job.json');
  const legacy = JSON.parse(await readFile(legacyPath, 'utf8'));
  delete legacy.poseIdentity;
  await writeFile(legacyPath, JSON.stringify(legacy));
  assert.equal(cache.readCurrent('job', f.offered), null, 'old caches must be rechecked');
  assert.equal((await cache.schedule('job', video, f.offered)).candidate.timeMs, 1600);
  assert.equal(calls, 3, 'old caches must be computed once with actual pose provenance');

  const p = await fixture('provided'); let providedCalls = 0;
  await writeFile(p.offered, JSON.stringify({ timeMs: 900 }));
  const provided = cacheModule.createImpactReviewCache({ dataDir: p.data, run: async id => {
    providedCalls++; return candidate(id, 900, await proof(p.offered, 'provided'));
  }});
  await provided.schedule('job', video, p.offered);
  await writeFile(p.fallback, 'changed but unused');
  assert.ok(provided.readCurrent('job', p.offered), 'unused fallback changes must not invalidate provided-pose results');
  await provided.schedule('job', video, p.offered); assert.equal(providedCalls, 1);

  const r = await fixture('race');
  const racing = cacheModule.createImpactReviewCache({ dataDir: r.data, run: async id => {
    const old = await proof(r.fallback, 'isolated');
    const tempPath = join(r.data, 'new.json'); await writeFile(tempPath, 'replaced'); await rename(tempPath, r.fallback);
    return candidate(id, 800, old);
  }});
  await assert.rejects(racing.schedule('job', video, r.offered), /pose/i);
  assert.equal(racing.read('job'), null, 'a changed actual pose must never be cached');

  const m = await fixture('missing-proof');
  const missing = cacheModule.createImpactReviewCache({ dataDir: m.data, run: async id => candidate(id, 800, undefined) });
  await assert.rejects(missing.schedule('job', video, m.offered), /pose/i);
  assert.equal(missing.read('job'), null, 'old infer responses cannot establish actual pose identity');

  const s = await fixture('symlink');
  const outside = join(root, 'outside.json'); await writeFile(outside, 'outside');
  await rm(s.fallback); await symlink(outside, s.fallback);
  const escaped = cacheModule.createImpactReviewCache({ dataDir: s.data, run: async id => candidate(id, 800, await proof(outside, 'isolated')) });
  await assert.rejects(escaped.schedule('job', video, s.offered), /pose/i);
  assert.equal(escaped.read('job'), null);

  const inside = await fixture('inside-symlink');
  const wrongPose = join(inside.data, 'other.json'); await writeFile(wrongPose, '{}');
  await rm(inside.fallback); await symlink(wrongPose, inside.fallback);
  const wrong = cacheModule.createImpactReviewCache({ dataDir: inside.data, run: async id => candidate(id, 800, await proof(wrongPose, 'isolated')) });
  await assert.rejects(wrong.schedule('job', video, inside.offered), /pose/i);
  assert.equal(wrong.read('job'), null, 'an isolated pose must belong to the video-specific cache path');

  const writing = await fixture('write-race');
  const beforeRename = cacheModule.createImpactReviewCache({ dataDir: writing.data, run: async id => candidate(id, 800, await proof(writing.fallback, 'isolated')) });
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function (file, ...args) {
    const output = originalWrite.call(this, file, ...args);
    if (String(file).endsWith('/impact-review-results/job.json.tmp')) {
      const replacement = join(writing.data, 'replacement.json');
      originalWrite.call(this, replacement, 'changed after verification');
      fs.renameSync(replacement, writing.fallback);
    }
    return output;
  };
  try {
    await assert.rejects(beforeRename.schedule('job', video, writing.offered), /changed/i);
    assert.equal(beforeRename.read('job'), null, 'a pose replaced before cache publication must not be saved');
  } finally { fs.writeFileSync = originalWrite; }
  console.log('actual provided/isolated pose provenance, cache invalidation, race and path containment passed');
} finally { await rm(root, { recursive: true, force: true }); }
