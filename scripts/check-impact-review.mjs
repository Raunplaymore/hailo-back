import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import cacheModule from '../store/impactReviewCache.js';
const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const route = source.slice(source.indexOf("app.post('/api/analyze/:jobId/impact-review'"), source.indexOf("app.get('/api/analyze/:jobId',"));
let handler;
const calls = [];
const shot = { status: 'done', metadata: { analysisInput: { path: '/uploads/known.mp4' } } };
vm.runInNewContext(route, {
  app: { post: (_path, fn) => { handler = fn; } },
  shotStore: { getShotByJobId: (id) => id === 'known' ? shot : null },
  fs: { existsSync: () => true }, bodyArtifactPath: () => '/data/body/known.json',
  scheduleAutomaticImpact: async (...args) => { calls.push(args); return {status: 'reference_candidate'}; },
});
async function request(jobId, body) {
  const res = {statusCode: 200, status(s) { this.statusCode = s; return this; }, json(data) { this.data = data; return this; }};
  await handler({params: {jobId}, body}, res); return res;
}
assert.equal((await request('known', {confirmedInput: false})).statusCode, 400);
assert.equal((await request('missing', {automatic: true})).statusCode, 404);
assert.equal((await request('../known', {automatic: true})).statusCode, 400);
assert.equal(calls.length, 0);
assert.equal((await request('known', {automatic: true, inputPath: '/etc/passwd'})).statusCode, 200);
assert.equal(calls[0][1], '/uploads/known.mp4');
shot.metadata.handedness = 'left';
assert.equal((await request('known', {automatic: true})).statusCode, 422);
assert.equal(calls.length, 1);

const root = await mkdtemp(join(tmpdir(), 'impact-cache-'));
try {
  const video=join(root,'video.mp4'); await writeFile(video,'original video');
  const result = (jobId) => ({ok:true, jobId, status:'reference_candidate',modelSha256:'70b338b519565f870ed1fce044a0453f828773e53b9fa9d024391b3b4cf57733',publicValue:null,automaticCoachingReady:false,appliedToPrimary:false,inputScopeConfirmed:false});
  let runs=0; let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const cache=cacheModule.createImpactReviewCache({dataDir:root,run:async (id)=>{runs++;await gate;return result(id);}});
  const first=cache.schedule('job',video), duplicate=cache.schedule('job',video);
  assert.equal(first,duplicate,'same input must join the active request');
  release(); await first; assert.equal(runs,1);
  await cache.schedule('job',video); assert.equal(runs,1,'saved result must be reused');
  const reopened=cacheModule.createImpactReviewCache({dataDir:root,run:async ()=>{throw Error('must not recompute after restart');}});
  await reopened.schedule('job',video);
  await writeFile(video,'changed source video');
  await cache.schedule('job',video); assert.equal(runs,2,'changed video must invalidate cache');
  const retry=cacheModule.createImpactReviewCache({dataDir:join(root,'retry'),run:async(id)=>{if(id==='bad')throw Error('failed');return result(id);}});
  await assert.rejects(retry.schedule('bad',video));
  assert.equal((await retry.schedule('good',video)).jobId,'good','failed job must not poison later queued jobs');
  assert.equal((await readFile(video,'utf8')),'changed source video');
} finally { await rm(root,{recursive:true,force:true}); }
console.log('automatic impact route, cache, deduplication and failure-recovery checks passed');
