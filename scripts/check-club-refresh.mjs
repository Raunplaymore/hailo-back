import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const { matchesVideoIdentity } = createRequire(import.meta.url)('../store/impactReviewCache.js');
const source = fs.readFileSync('server.js', 'utf8');
const code = source.slice(source.indexOf('function summarizeDtlClubPointsV2('), source.indexOf('\nfunction eventTimeMs'));
const oldSidecar = { status: 'succeeded', observations: { revision: 1 }, marker: 'old' };
const identity = { dev: 1, ino: 1, size: 100, mtimeMs: 1, ctimeMs: 1 };

{
  const start=source.indexOf('async function requestDtlClubPointsV2SidecarAnalysis(');
  const end=source.indexOf('\nlet dtlClubPointsV2Tail',start);
  assert.ok(start>=0 && end>start);
  let reply, sent, ok=true;
  const context=vm.createContext({DTL_V2_TAKEAWAY_PROFILE:'test',inferUrl:path=>path,
    inferFetchJson:async (_url,options)=>{sent=options.body;return {ok,json:reply};}});
  vm.runInContext(source.slice(start,end),context);
  for (const flag of [undefined,true,false]) {
    reply={ok:true,jobId:'job',result:{jobId:'job',status:'done'},...(flag===undefined?{}:{bodyFallbackAllowed:flag})};
    const result=await context.requestDtlClubPointsV2SidecarAnalysis({jobId:'job',metaPath:'/meta',bodyPath:null});
    assert.equal(sent.allowBodyFallback,false);
    assert.equal(sent.bodyPath,null);
    assert.equal(result?.status ?? null,flag===false?'done':null,'an older or permissive infer response must not be accepted');
  }
  reply={ok:true,jobId:'different',bodyFallbackAllowed:false,result:{jobId:'job',status:'done'}};
  assert.equal(await context.requestDtlClubPointsV2SidecarAnalysis({jobId:'job',metaPath:'/meta'}),null);
  reply={ok:true,jobId:'job',bodyFallbackAllowed:false,result:{jobId:'different',status:'done'}};
  assert.equal(await context.requestDtlClubPointsV2SidecarAnalysis({jobId:'job',metaPath:'/meta'}),null);
  ok=false;reply={detail:{jobId:'job',errorCode:'BODY_UNAVAILABLE'}};
  await assert.rejects(context.requestDtlClubPointsV2SidecarAnalysis({jobId:'job',metaPath:'/meta'}), error=>error.code==='BODY_UNAVAILABLE');
  reply={detail:{jobId:'different',errorCode:'BODY_UNAVAILABLE'}};
  assert.equal(await context.requestDtlClubPointsV2SidecarAnalysis({jobId:'job',metaPath:'/meta'}),null);
}

{
  const start=source.indexOf('async function hashVideoFile('), end=source.indexOf('\nfunction queueAutomaticImpact(', start);
  assert.ok(start >= 0 && end > start);
  const hashContext=vm.createContext({createHash,fs});
  vm.runInContext(source.slice(start,end),hashContext);
  const dir=fs.mkdtempSync(path.join(tmpdir(),'club-video-hash-'));
  try {
    const video=path.join(dir,'video.mp4');fs.writeFileSync(video,'a test video');
    assert.equal(await hashContext.hashVideoFile(video),createHash('sha256').update('a test video').digest('hex'));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}

function harness() {
  let cache = { jobId: 'job', status: 'done', progress: { bodyPath: '/body.json' },
    analysis: { events: { impact: { timeMs: 100 } }, debug: { dtlClubPointsV2: oldSidecar } }, dtlClubPointsV2: oldSidecar };
  let shot = { media: { path: '/video.mp4', filename: 'video.mp4' }, metadata: {} };
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const files = new Map([['/video.mp4', { ...identity }], ['/body.json', { ...identity, ino: 2 }]]);
  const metadataIdentity = { ...identity, ino: 3 };
  const calls = { meta: [], sidecar: [], archives: 0, failMeta: false, failArchive: false, failImpact: false, failBody: false, verifiedCoverage: false };
  const context = vm.createContext({
    console, Date, path, randomUUID, matchesVideoIdentity, DTL_V2_TAKEAWAY_PROFILE: 'test', DTL_V2_STALE_RUNNING_MS: 1000,
    fs: { existsSync: file => files.has(file), statSync: file => { if (!files.has(file)) throw new Error('missing file'); return { ...files.get(file) }; },
      lstatSync: () => ({ ...metadataIdentity, isFile: () => true }) },
    readAnalysisCache: () => cache && structuredClone(cache),
    writeAnalysisCache: (_jobId, value) => { cache = structuredClone(value); return structuredClone(cache); },
    shotStore: { getShotByJobId: () => shot && structuredClone(shot) }, bodyArtifactPath: () => '/body.json',
    resolveMetaPath: value => value,
    getVideoMeta: async () => ({ durationMs: 1000 }),
    requestDtlClubPointsV2MetaGeneration: async args => { calls.meta.push(args); entered(); await gate; return calls.failMeta ? null : { metaPath: `/tmp/${args.metadataJobId}.meta.json`, durationMs: 20 }; },
    scheduleAutomaticImpact: async () => { if (calls.failImpact) throw new Error('impact unavailable'); return { candidate: { timeMs: 100 }, videoSha256: 'a'.repeat(64) }; },
    verifyClubSourceCoverage: async ({overlay}) => { calls.onCoverage?.(); return calls.verifiedCoverage
      ? { status: 'verified', missingFrames: 1, overlay } : { status: 'unverified', overlay }; },
    hashVideoFile: async () => { calls.onHash?.(); return 'a'.repeat(64); },
    requestDtlClubPointsV2SidecarAnalysis: async args => { calls.sidecar.push(args); if(calls.failBody)throw Object.assign(new Error('missing pose'),{code:'BODY_UNAVAILABLE'}); return { ok: true, status: 'done', events: { takeawayMs: 20 },
      eventValidation: { eventQuality: { takeaway: { status: 'confirmed' } } },
      clubObservations: { revision: 1, marker: 'new' }, overlay: { clubTimeSource: 'video_pts', clubFrames: [] } }; },
    queueNasArchive: () => { calls.archives++; if (calls.failArchive) throw new Error('archive unavailable'); },
    updateNasArchiveStatus: (_jobId, patch) => { cache.nasArchive = patch; },
  });
  vm.runInContext('let dtlClubPointsV2Tail = Promise.resolve(); const activeDtlClubPointsV2 = new Map();\n' + code, context);
  return { context, started, release, files, calls, metadataIdentity, get cache() { return cache; }, set cache(value) { cache = value; },
    get shot() { return shot; }, set shot(value) { shot = value; }, settle: () => vm.runInContext('dtlClubPointsV2Tail', context) };
}

{
  const h = harness();
  h.cache.dtlClubPointsV2 = { status: 'failed' };
  h.cache.dtlClubRefresh = { id: 'interrupted-before-restart', status: 'running' };
  h.context.scheduleDtlClubPointsV2Sidecar('job');
  await h.started;
  const concurrent = h.context.scheduleDtlClubPointsV2Sidecar('job', { force: true, refresh: true });
  assert.equal(concurrent.reason, 'already scheduled');
  assert.equal(concurrent.refreshId, undefined, 'an automatic run must not reuse a stale refresh id');
  h.release(); await h.settle();
}

{
  const h = harness();
  assert.equal(h.context.scheduleDtlClubPointsV2Sidecar('job', { force: true }).scheduled, false);
  const run = h.context.scheduleDtlClubPointsV2Sidecar('job', { force: true, refresh: true });
  assert.equal(run.scheduled, true);
  assert.equal(h.context.scheduleDtlClubPointsV2Sidecar('job', { force: true, refresh: true }).refreshId, run.refreshId);
  await h.started;
  assert.deepEqual(h.cache.dtlClubPointsV2, oldSidecar, 'old result remains available while running');
  assert.equal(h.calls.meta[0].metadataJobId, `club-refresh-${run.refreshId}`);
  h.release(); await h.settle();
  assert.equal(h.cache.dtlClubRefresh.status, 'succeeded');
  assert.equal(h.cache.dtlClubPointsV2.observations.marker, 'new');
  assert.equal(h.cache.dtlClubRefreshSource.source.path, '/video.mp4');
  assert.equal(h.cache.dtlClubRefreshSource.body.path, '/body.json');
  assert.deepEqual(h.cache.dtlClubPointsV2BeforeRefresh, oldSidecar);
  assert.equal(h.cache.analysis.debug.dtlClubPointsV2.observations.marker, 'new');
  assert.equal(h.cache.analysis.events.takeaway, undefined, 'refresh must not alter primary events');
  assert.equal(h.calls.archives, 1);
  const again = h.context.scheduleDtlClubPointsV2Sidecar('job', { force: true, refresh: true });
  assert.notEqual(again.refreshId, run.refreshId);
  await h.settle();
  assert.deepEqual(h.cache.dtlClubPointsV2BeforeRefresh, oldSidecar, 'first result remains recoverable');
}

for (const change of ['failed-meta', 'source-changed', 'body-changed', 'body-appeared', 'body-path-changed', 'shot-changed', 'view-changed', 'sidecar-changed', 'debug-changed', 'deleted']) {
  const h = harness();
  if (change === 'body-appeared') h.files.delete('/body.json');
  h.context.scheduleDtlClubPointsV2Sidecar('job', { force: true, refresh: true });
  await h.started;
  if (change === 'failed-meta') h.calls.failMeta = true;
  if (change === 'source-changed') h.files.get('/video.mp4').ctimeMs++;
  if (change === 'body-changed') h.files.get('/body.json').mtimeMs++;
  if (change === 'body-appeared') h.files.set('/body.json', { ...identity, ino: 3 });
  if (change === 'body-path-changed') h.cache.progress.bodyPath = '/other-body.json';
  if (change === 'shot-changed') h.shot.media.path = '/other.mp4';
  if (change === 'view-changed') h.shot.metadata.handedness = 'left';
  if (change === 'sidecar-changed') h.cache.dtlClubPointsV2 = { ...oldSidecar, marker: 'someone-else' };
  if (change === 'debug-changed') h.cache.analysis.debug.dtlClubPointsV2 = { ...oldSidecar, marker: 'someone-else' };
  if (change === 'deleted') h.cache = null;
  h.release(); await h.settle();
  if (change === 'deleted') assert.equal(h.cache, null, 'deleted cache must not be recreated');
  else {
    assert.equal(h.cache.dtlClubRefresh.status, 'failed', change);
    assert.equal(h.cache.dtlClubPointsV2.marker, change === 'sidecar-changed' ? 'someone-else' : 'old', change);
  }
  assert.equal(h.calls.archives, 0, change);
}

{
  const h = harness();
  h.cache.dtlClubPointsV2 = null;
  h.context.scheduleDtlClubPointsV2Sidecar('job', { force: true, refresh: true });
  await h.started; h.release(); await h.settle();
  assert.equal(h.cache.dtlClubPointsV2BeforeRefresh.marker, 'old', 'debug-only previous result is preserved');
}

{
  const h = harness();
  h.cache.analysis.debug.dtlClubPointsV2 = { ...oldSidecar, marker: 'different-debug-result' };
  h.context.scheduleDtlClubPointsV2Sidecar('job', { force: true, refresh: true });
  await h.started; h.release(); await h.settle();
  assert.equal(h.cache.dtlClubPointsV2BeforeRefresh.marker, 'old');
  assert.equal(h.cache.dtlClubPointsV2DebugBeforeRefresh.marker, 'different-debug-result');
}

{
  const h = harness();
  h.calls.failArchive = true;
  h.context.scheduleDtlClubPointsV2Sidecar('job', { force: true, refresh: true });
  await h.started; h.release(); await h.settle();
  assert.equal(h.cache.dtlClubRefresh.status, 'succeeded', 'archive failure must not undo a saved result');
  assert.equal(h.cache.nasArchive.state, 'failed');
}

{
  const h = harness();
  const usable = { ...oldSidecar, observations: { revision: 1, levels: [{status:'observation'}] } };
  h.cache.dtlClubPointsV2 = structuredClone(usable);
  h.cache.analysis.debug.dtlClubPointsV2 = structuredClone(usable);
  h.calls.failImpact = true;
  h.context.scheduleDtlClubPointsV2Sidecar('job', { force: true, refresh: true });
  await h.started; h.release(); await h.settle();
  assert.equal(h.cache.dtlClubRefresh.status, 'failed');
  assert.deepEqual(h.cache.dtlClubPointsV2, usable, 'do not replace an existing comparison without an impact candidate');
  assert.equal(h.calls.sidecar.length, 0);
}

for (const refresh of [false, true]) {
  const h = harness();
  h.cache.dtlClubPointsV2 = {status:'failed'};
  h.cache.analysis.debug.dtlClubPointsV2 = null;
  h.calls.failImpact = true;
  h.context.scheduleDtlClubPointsV2Sidecar('job', refresh ? {force:true,refresh:true} : {});
  await h.started; h.release(); await h.settle();
  assert.equal(h.cache.dtlClubPointsV2.status, 'succeeded');
  assert.equal(h.cache.dtlClubPointsV2.overlayVideoSha256, 'a'.repeat(64));
  assert.equal(h.cache.dtlClubPointsV2.overlay, null, 'older clients must not render the unbound fallback');
  assert.equal(h.cache.dtlClubPointsV2.pendingOverlay.clubTimeSource, 'video_pts');
  assert.equal(h.cache.dtlClubPointsV2.observations.reason, 'IMPACT_CANDIDATE_UNAVAILABLE');
  assert.equal(h.cache.dtlClubPointsV2.observations.levels.length, 0);
  assert.equal(h.calls.sidecar[0].impactMs, undefined);
  assert.equal(h.cache.analysis.events.takeaway, undefined, 'do not promote a legacy event without an impact candidate');
  if (refresh) assert.equal(h.cache.dtlClubRefresh.status, 'succeeded');
}

for (const refresh of [false, true]) {
  const h = harness();
  h.files.delete('/body.json');h.calls.failBody=true;h.calls.failImpact=true;
  h.cache.dtlClubPointsV2 = {status:'failed'};
  h.cache.analysis.debug.dtlClubPointsV2 = null;
  h.context.scheduleDtlClubPointsV2Sidecar('job', refresh ? {force:true,refresh:true} : {});
  await h.started;h.release();await h.settle();
  assert.equal(refresh?h.cache.dtlClubRefresh.errorCode:h.cache.dtlClubPointsV2.errorCode,'BODY_UNAVAILABLE');
  assert.equal(h.calls.archives,0);
}

for (const refresh of [false, true]) {
  const h = harness();
  h.files.delete('/body.json');
  h.cache.dtlClubPointsV2 = {status:'failed'};
  h.cache.analysis.debug.dtlClubPointsV2 = null;
  h.calls.failImpact = true;
  h.context.scheduleDtlClubPointsV2Sidecar('job', refresh ? {force:true,refresh:true} : {});
  await h.started; h.release(); await h.settle();
  assert.equal(h.calls.sidecar[0].bodyPath, null, 'an absent pose must not be passed as a usable file');
  assert.equal(h.cache.dtlClubPointsV2.status, 'succeeded');
}

{
  const h = harness();
  h.cache.dtlClubPointsV2 = {status:'failed'};
  h.cache.analysis.debug.dtlClubPointsV2 = null;
  h.calls.failImpact = true;
  h.calls.onHash = () => { h.files.get('/video.mp4').ctimeMs++; };
  h.context.scheduleDtlClubPointsV2Sidecar('job', { force: true, refresh: true });
  await h.started; h.release(); await h.settle();
  assert.equal(h.cache.dtlClubRefresh.status, 'failed', 'do not save a trajectory when its source changed');
  assert.equal(h.cache.dtlClubPointsV2.status, 'failed');
  assert.equal(h.calls.archives, 0);
}

{
  const h = harness();
  h.cache.dtlClubPointsV2 = {status:'failed'}; h.cache.analysis.debug.dtlClubPointsV2 = null;
  h.calls.verifiedCoverage = true;
  h.context.scheduleDtlClubPointsV2Sidecar('job');
  await h.started; h.release(); await h.settle();
  assert.equal(h.cache.dtlClubPointsV2.sourceFrameCoverage.status,'verified');
  assert.equal(h.cache.dtlClubPointsV2.sourceFrameCoverage.missingFrames,1);
  assert.equal(h.cache.dtlClubPointsV2.overlay,null);
  assert.equal(h.cache.dtlClubPointsV2.overlayVideoSha256,'a'.repeat(64));
  assert.equal(h.cache.dtlClubPointsV2.pendingOverlay.clubTimeSource,'video_pts');
}

{
  const h = harness();
  h.cache.dtlClubPointsV2 = {status:'failed'}; h.cache.analysis.debug.dtlClubPointsV2 = null;
  h.calls.verifiedCoverage = true;
  h.calls.onCoverage = () => { h.files.get('/video.mp4').ctimeMs++; };
  h.context.scheduleDtlClubPointsV2Sidecar('job');
  await h.started; h.release(); await h.settle();
  assert.equal(h.cache.dtlClubPointsV2.status,'failed','verified coverage must not be saved if its video changed');
  assert.equal(h.calls.archives,0);
}
{
  const h = harness();
  h.cache.dtlClubPointsV2 = {status:'failed'}; h.cache.analysis.debug.dtlClubPointsV2 = null;
  h.calls.verifiedCoverage = true;
  h.calls.onCoverage = () => { h.metadataIdentity.ctimeMs++; };
  h.context.scheduleDtlClubPointsV2Sidecar('job');
  await h.started; h.release(); await h.settle();
  assert.equal(h.cache.dtlClubPointsV2.status,'failed','verified coverage must not be saved if metadata changed');
  assert.equal(h.calls.archives,0);
}
for (const changed of ['video','metadata']) {
  const h = harness();
  h.cache.dtlClubPointsV2 = {status:'failed'}; h.cache.analysis.debug.dtlClubPointsV2 = null;
  h.calls.onCoverage = () => { if(changed==='video')h.files.get('/video.mp4').ctimeMs++;else h.metadataIdentity.ctimeMs++; };
  h.context.scheduleDtlClubPointsV2Sidecar('job');
  await h.started; h.release(); await h.settle();
  assert.equal(h.cache.dtlClubPointsV2.status,'failed',`unverified coverage cannot save a changed ${changed}`);
  assert.equal(h.calls.archives,0);
}
console.log('club refresh preserves prior data, checks inputs and handles failures');
