import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, stat, utimes, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import cacheModule from '../store/impactReviewCache.js';
const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const routeStart = source.indexOf("app.post('/api/analyze/:jobId/impact-review'");
const routeEnd = source.indexOf('\napp.', routeStart + 1);
assert.ok(routeStart >= 0 && routeEnd > routeStart);
const route = source.slice(routeStart, routeEnd);
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
  const result = (jobId) => ({ok:true, jobId, status:'reference_candidate',timingRevision:3,modelSha256:'70b338b519565f870ed1fce044a0453f828773e53b9fa9d024391b3b4cf57733',videoSha256:'a'.repeat(64),publicValue:null,automaticCoachingReady:false,appliedToPrimary:false,inputScopeConfirmed:false});
  let runs=0; let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const cache=cacheModule.createImpactReviewCache({dataDir:root,run:async (id)=>{runs++;await gate;return result(id);}});
  const first=cache.schedule('job',video), duplicate=cache.schedule('job',video);
  assert.equal(first,duplicate,'same input must join the active request');
  release(); await first; assert.equal(runs,1);
  await cache.schedule('job',video); assert.equal(runs,1,'saved result must be reused');
  const reopened=cacheModule.createImpactReviewCache({dataDir:root,run:async ()=>{throw Error('must not recompute after restart');}});
  await reopened.schedule('job',video);
  const savedPath=join(root,'impact-review-results','job.json');
  const stale=JSON.parse(await readFile(savedPath,'utf8'));
  stale.result.timingRevision=2;
  await writeFile(savedPath,JSON.stringify(stale));
  assert.equal(cache.read('job').inputPath,video,'old video identity must stay readable during timing migration');
  assert.equal(cache.read('job').result.timingRevision,2);
  await cache.schedule('job',video); assert.equal(runs,2,'old timing must be recomputed');
  const oldIdentity=JSON.parse(await readFile(savedPath,'utf8'));delete oldIdentity.ctimeMs;
  await writeFile(savedPath,JSON.stringify(oldIdentity));
  await cache.schedule('job',video);assert.equal(runs,3,'old incomplete identity must be recomputed');
  await writeFile(video,'changed source video');
  await cache.schedule('job',video); assert.equal(runs,4,'changed video must invalidate cache');
  const racing=cacheModule.createImpactReviewCache({dataDir:join(root,'race'),run:async(id)=>{await writeFile(video,'modified during inference');return result(id);}});
  await assert.rejects(racing.schedule('race',video),/changed during impact analysis/);
  assert.equal(racing.read('race'),null,'changed inputs must never leave a saved candidate');
  await writeFile(video,'changed source video');
  const same=join(root,'same.mp4'), replacement=join(root,'replacement.mp4'), fixed=new Date('2020-01-01T00:00:00.000Z');
  await writeFile(same,'video');await utimes(same,fixed,fixed);let sameRuns=0;
  const sameCache=cacheModule.createImpactReviewCache({dataDir:join(root,'same-cache'),run:async(id)=>{sameRuns++;return result(id);}});
  await sameCache.schedule('same',same);const before=await stat(same);
  await writeFile(replacement,'other');await utimes(replacement,fixed,fixed);await rename(replacement,same);
  const after=await stat(same);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.notEqual(after.ino,before.ino);
  await sameCache.schedule('same',same);assert.equal(sameRuns,2,'same-size replacement with preserved mtime must invalidate the candidate');
  const invalidHash=cacheModule.createImpactReviewCache({dataDir:join(root,'bad-hash'),run:async(id)=>({...result(id),videoSha256:'invalid'})});
  await assert.rejects(invalidHash.schedule('bad-hash',same),/Invalid automatic impact/);
  assert.equal(invalidHash.read('bad-hash'),null);
  const retry=cacheModule.createImpactReviewCache({dataDir:join(root,'retry'),run:async(id)=>{if(id==='bad')throw Error('failed');return result(id);}});
  await assert.rejects(retry.schedule('bad',video));
  assert.equal((await retry.schedule('good',video)).jobId,'good','failed job must not poison later queued jobs');
  assert.equal((await readFile(video,'utf8')),'changed source video');
} finally { await rm(root,{recursive:true,force:true}); }
let registration;
let queued;
let bodyExists = true;
const existing={id:'old',sourceType:'upload',metadata:{keep:'value'},analysis:{tempo:3}};
const registrationSource=source.slice(source.indexOf('function queueAutomaticImpactWithAvailableBody('),source.indexOf('// Ensure upload directory exists'));
const registrationContext={
  fs:{existsSync:(file)=>String(file).startsWith('/data/body/') ? bodyExists : true,statSync:()=>({isFile:()=>true,size:5})},
  shotStore:{getShotByMediaName:()=>existing,upsertShot:(value)=>{registration=value;}},
  bodyArtifactPath:(jobId)=>`/data/body/${jobId}.json`,
  randomUUID:()=> 'new-id',queueAutomaticImpact:(...args)=>{queued=args;},
};
vm.createContext(registrationContext);
vm.runInContext(registrationSource+';registerFileImpact("camera-job","capture.mp4","/uploads/capture.mp4",{viewpoint:"down_the_line",handedness:"right"});',registrationContext);
assert.equal(registration.jobId,'camera-job');
assert.equal(registration.metadata.keep,'value');
assert.equal(registration.analysis,existing.analysis);
assert.equal(existing.metadata.analysisInput,undefined,'association must not mutate prior metadata');
assert.equal(queued[1],'/uploads/capture.mp4');
assert.equal(queued[2],'/data/body/camera-job.json','available body should be offered for verified reuse');
bodyExists = false;
vm.runInContext('registerFileImpact("camera-job","capture.mp4","/uploads/capture.mp4",{viewpoint:"down_the_line",handedness:"right"});',registrationContext);
assert.equal(queued[2],null,'missing body should trigger safe fresh analysis');
let explicitQueued;
const explicitStart=source.indexOf('  if (explicitMetaPath) {');
const explicitEnd=source.indexOf('    progress = ',explicitStart);
assert.ok(explicitStart >= 0 && explicitEnd > explicitStart);
vm.runInNewContext(source.slice(explicitStart,explicitEnd)+'}', {
  explicitMetaPath:'/data/meta.json',jobId:'upload-job',file:{path:'/uploads/capture.mp4'},meta:{viewpoint:'down_the_line'},
  queueAutomaticImpactWithAvailableBody:(...args)=>{explicitQueued=args;},
});
assert.equal(explicitQueued[0],'upload-job');
assert.equal(explicitQueued[1],'/uploads/capture.mp4');
assert.equal(explicitQueued[2].viewpoint,'down_the_line');
console.log('automatic impact route, cache, deduplication, camera association and failure-recovery checks passed');
