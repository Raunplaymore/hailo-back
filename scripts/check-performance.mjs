import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
const source = fs.readFileSync('server.js', 'utf8');
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const result = {status: 'succeeded', analysisVersion: 'current', events: {impact: {timeMs: 2905}}, metrics: {tempo: {}}};
let cache = {status: 'done', analysis: result, progress: {stage: 'fusion_succeeded'}, dtlClubPointsV2: {status: 'succeeded'}, nasArchive: {state: 'stored'}};
let writes = 0, inferCalls = 0, schedules = 0;
const context = {
  console, Date, process, path, activeUploadJobs: new Set(),
  fs: {existsSync: () => false},
  readAnalysisCache: () => cache,
  hasFreshInferAnalysis: c => c.analysis?.analysisVersion === 'current',
  hasUsableInferMetrics: a => Boolean(a?.metrics),
  shotStore: {getShotByJobId: () => null}, bodyArtifactPath: () => null,
  hydrateOverlayFromBodyArtifact: async a => a, inferUrl: p => p,
  inferFetchJson: async url => {inferCalls++; return {ok: true, json: url.endsWith('/result') ? result : {status: 'done'}};},
  mapInferStatus: s => s, buildGroupedProgress: (stage, patch = {}) => ({stage, ...patch}), inferAnalysisPath: () => '/tmp/result',
  normalizeInferResult: () => result,
  writeAnalysisCache: (_id, value) => {writes++; cache = value; return value;},
  scheduleDtlClubPointsV2Sidecar: () => {schedules++;},
};
vm.createContext(context);
vm.runInContext(part('async function fetchInferJobPayload(', '\nfunction buildShotJobResponse'), context);
const original = JSON.stringify(cache);
await Promise.all(Array.from({length: 8}, (_, i) => context.fetchInferJobPayload('job', {includeResult: Boolean(i % 2)})));
assert.equal(JSON.stringify(cache), original);
assert.equal(writes + inferCalls + schedules, 0, 'completed reads must not write, call infer, or schedule sidecars');
cache = {...cache, status: 'running'};
await context.fetchInferJobPayload('job', {includeResult: true});
assert.equal(cache.status, 'done');
assert.equal(cache.dtlClubPointsV2.status, 'succeeded');
assert.equal(cache.nasArchive.state, 'stored');
assert.equal(writes, 1);
cache = {...cache, analysis: {...result, analysisVersion: 'old'}};
await context.fetchInferJobPayload('job', {includeResult: true});
assert.equal(cache.analysis.analysisVersion, 'current', 'old versions must still refresh');

// A refreshed club result survives a primary-result reload only for the same saved inputs.
const identity = {dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5};
let currentIdentity = identity;
context.fs.existsSync = () => true;
context.fs.statSync = () => currentIdentity;
context.matchesVideoIdentity = (saved, stat) => Object.keys(identity).every(key => saved[key] === stat[key]);
context.shotStore.getShotByJobId = () => ({media: {path: '/video.mp4'}, metadata: {}});
context.normalizeInferResult = () => structuredClone(result);
const sidecar = {status: 'succeeded', marker: 'refreshed', metaPath:'/tmp/refresh.meta.json', completedAt:'finished'};
cache = {status:'done', analysis:{...result,analysisVersion:'old'}, progress:{bodyPath:'/body.json'}, dtlClubPointsV2:sidecar,
  dtlClubRefresh:{status:'succeeded'}, dtlClubRefreshSource:{metaPath:sidecar.metaPath,completedAt:sidecar.completedAt,source:{path:'/video.mp4',...identity},input:{path:'/video.mp4',...identity},body:{path:'/body.json',...identity},viewpoint:null,handedness:null}};
await context.fetchInferJobPayload('job', {includeResult:true});
assert.equal(cache.analysis.debug.dtlClubPointsV2.marker,'refreshed');
cache.analysis = {...result,analysisVersion:'old'};
cache.dtlClubRefresh.status = 'failed';
await context.fetchInferJobPayload('job', {includeResult:true});
assert.equal(cache.analysis.debug.dtlClubPointsV2.marker,'refreshed','a failed later refresh preserves the last successful result');
cache.analysis = {...result,analysisVersion:'old'};
currentIdentity = {...identity,size:4};
await context.fetchInferJobPayload('job', {includeResult:true});
assert.equal(cache.analysis.debug?.dtlClubPointsV2,undefined,'changed input must not receive an old overlay');

// Exercise the real scheduling guard even if a competing writer loses its disk flag.
let queuedCache = {status: 'done'};
let release;
let runs = 0;
const gate = new Promise(resolve => {release = resolve;});
const queueContext = {
  console, Date, path, DTL_V2_TAKEAWAY_PROFILE: 'test',
  fs: {existsSync: () => true, statSync: () => identity},
  readAnalysisCache: () => queuedCache,
  isStaleDtlClubPointsV2Run: () => false,
  updateDtlClubPointsV2Cache: (_id, sidecar) => {queuedCache = {...queuedCache, dtlClubPointsV2: sidecar};},
  shotStore: {getShotByJobId: () => ({media: {path: '/video.mp4'}})},
  bodyArtifactPath: () => '/body.json', getVideoMeta: async () => ({}),
  requestDtlClubPointsV2MetaGeneration: async () => {runs++; await gate; return null;},
};
vm.createContext(queueContext);
vm.runInContext('let dtlClubPointsV2Tail = Promise.resolve(); const activeDtlClubPointsV2 = new Map();\n' + part('function scheduleDtlClubPointsV2Sidecar(', '\nfunction eventTimeMs'), queueContext);
assert.equal(queueContext.scheduleDtlClubPointsV2Sidecar('job').scheduled, true);
queuedCache = {status: 'done'};
assert.equal(queueContext.scheduleDtlClubPointsV2Sidecar('job', {force: true}).scheduled, false);
release();
await vm.runInContext('dtlClubPointsV2Tail', queueContext);
assert.equal(runs, 1);

let route, reads = 0, cacheReads = 0;
const shots = [{jobId: 'a', media: {filename: 'a.mov'}, status: 'running'}, {jobId: 'b', media: {filename: 'b.mp4'}}];
const listing = {
  console, path, app: {get: (_p, handler) => {route = handler;}}, uploadDir: '/uploads',
  fs: {promises: {readdir: async () => shots.map(s => ({name: s.media.filename, isFile: () => true})), stat: async () => ({size: 10, mtime: new Date(0)})}},
  shotStore: {listShots: () => {reads++; return shots;}},
  isSafeJobId: id => /^[a-z]+$/.test(id), isSupportedVideoExt: () => true,
  readAnalysisCache: () => {cacheReads++; return {status: 'done', analysis: result, nasArchive: {state: 'stored', artifacts: ['private fingerprints']}};},
  mapCacheStatusToFileStatus: () => 'succeeded', normalizeJobStatus: x => x,
  localThumbnailUrl: () => null, uploadsUrl: x => `/uploads/${x}`,
};
vm.createContext(listing);
vm.runInContext(part("app.get('/api/files/detail'", "\napp.get('/api/debug/infer/"), listing);
const response = {status(code) {this.code = code; return this;}, json(value) {this.body = value; return this;}};
await route({query: {summary: 'true'}}, response);
assert.equal(reads, 1); assert.equal(response.body.files.length, 2);
assert.equal(response.body.files[0].status, 'succeeded');
assert.equal(response.body.files[0].analysis, null);
assert.equal(response.body.files[0].nasArchive.artifacts, undefined);
cacheReads = 0;
await route({query: {summary: 'true', jobIds: 'b'}}, response);
assert.equal(cacheReads, 1); assert.equal(response.body.files[0].jobId, 'b');
await route({query: {}}, response);
assert.equal(response.body.files[0].analysis, result, 'legacy full listing remains compatible');
await route({query: {jobIds: '../invalid'}}, response);
assert.equal(response.code, 400);
console.log('performance: idempotent completed reads, preserved states, V2 dedupe, summary/active listing passed');
