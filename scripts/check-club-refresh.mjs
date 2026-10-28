import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const { matchesVideoIdentity } = createRequire(import.meta.url)('../store/impactReviewCache.js');
const source = fs.readFileSync('server.js', 'utf8');
const code = source.slice(source.indexOf('function summarizeDtlClubPointsV2('), source.indexOf('\nfunction eventTimeMs'));
const oldSidecar = { status: 'succeeded', observations: { revision: 1 }, marker: 'old' };
const identity = { dev: 1, ino: 1, size: 100, mtimeMs: 1, ctimeMs: 1 };

function harness() {
  let cache = { jobId: 'job', status: 'done', progress: { bodyPath: '/body.json' },
    analysis: { events: { impact: { timeMs: 100 } }, debug: { dtlClubPointsV2: oldSidecar } }, dtlClubPointsV2: oldSidecar };
  let shot = { media: { path: '/video.mp4', filename: 'video.mp4' }, metadata: {} };
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const files = new Map([['/video.mp4', { ...identity }], ['/body.json', { ...identity, ino: 2 }]]);
  const calls = { meta: [], archives: 0, failMeta: false, failArchive: false };
  const context = vm.createContext({
    console, Date, path, randomUUID, matchesVideoIdentity, DTL_V2_TAKEAWAY_PROFILE: 'test', DTL_V2_STALE_RUNNING_MS: 1000,
    fs: { existsSync: file => files.has(file), statSync: file => { if (!files.has(file)) throw new Error('missing file'); return { ...files.get(file) }; } },
    readAnalysisCache: () => cache && structuredClone(cache),
    writeAnalysisCache: (_jobId, value) => { cache = structuredClone(value); return structuredClone(cache); },
    shotStore: { getShotByJobId: () => shot && structuredClone(shot) }, bodyArtifactPath: () => '/body.json',
    getVideoMeta: async () => ({ durationMs: 1000 }),
    requestDtlClubPointsV2MetaGeneration: async args => { calls.meta.push(args); entered(); await gate; return calls.failMeta ? null : { metaPath: `/tmp/${args.metadataJobId}.meta.json`, durationMs: 20 }; },
    scheduleAutomaticImpact: async () => ({ candidate: { timeMs: 100 } }),
    requestDtlClubPointsV2SidecarAnalysis: async () => ({ ok: true, status: 'done', events: { takeawayMs: 20 },
      eventValidation: { eventQuality: { takeaway: { status: 'confirmed' } } },
      clubObservations: { revision: 1, marker: 'new' }, overlay: { clubTimeSource: 'video_pts', clubFrames: [] } }),
    queueNasArchive: () => { calls.archives++; if (calls.failArchive) throw new Error('archive unavailable'); },
    updateNasArchiveStatus: (_jobId, patch) => { cache.nasArchive = patch; },
  });
  vm.runInContext('let dtlClubPointsV2Tail = Promise.resolve(); const activeDtlClubPointsV2 = new Map();\n' + code, context);
  return { context, started, release, files, calls, get cache() { return cache; }, set cache(value) { cache = value; },
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
console.log('club refresh preserves prior data, checks inputs and handles failures');
