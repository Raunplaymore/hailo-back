import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('server.js', 'utf8');
const start = source.indexOf('function summarizeDtlClubPointsV2(');
const end = source.indexOf('\n// V2 queue', start);
const context = vm.createContext({ DTL_V2_TAKEAWAY_PROFILE: 'test' });
vm.runInContext(source.slice(start, end), context);
const clubFrames = [{ timeMs: 17, frame: 1, head: { x: .2, y: .3 } }];
const result = { ok: true, status: 'done', overlay: { coordinateSpace: 'normalized', poseFrames: [{ timeMs: 17 }], clubFrames } };
assert.equal(context.summarizeDtlClubPointsV2(result, 'meta', 1).overlay, null);
result.overlay.clubTimeSource = 'video_pts';
const summary = context.summarizeDtlClubPointsV2(result, 'meta', 1);
assert.equal(summary.overlay.clubFrames, clubFrames);
assert.equal(summary.overlay.poseFrames.length, 0);
assert.equal(summary.takeaway.appliedToPrimary, false);
console.log('club sidecar overlay contract passed');

// The UI's explicit legacy refresh must not permit arbitrary jobs or unsupported views.
const routeStart = source.indexOf("app.post('/api/analyze/:jobId/club-review'");
const routeEnd = source.indexOf("app.post('/api/analyze/:jobId/impact-review'", routeStart);
let post, get, shot = { metadata: {} }, scheduled = { scheduled: true, reason: 'queued' }, clubCache = {dtlClubPointsV2: summary}, options;
const routes = vm.createContext({ app: { post: (_p, h) => {post=h;}, get: (_p, h) => {get=h;} },
  shotStore: { getShotByJobId: () => shot }, scheduleDtlClubPointsV2Sidecar: (_id, opts) => { options=opts; return scheduled; },
  readAnalysisCache: () => clubCache, activeDtlClubPointsV2: new Map() });
vm.runInContext(source.slice(routeStart,routeEnd),routes);
const response = () => ({ code: 200, status(c) {this.code=c;return this;}, sendStatus(c) {this.code=c;return this;}, json(value) {this.body=value;return this;} });
let res=response();post({params:{jobId:'../bad'}},res);assert.equal(res.code,400);
shot=null;res=response();post({params:{jobId:'job'}},res);assert.equal(res.code,404);
shot={metadata:{handedness:'left'}};res=response();post({params:{jobId:'job'}},res);assert.equal(res.code,422);
shot={metadata:{}};res=response();post({params:{jobId:'job'}},res);assert.equal(res.code,202);
assert.equal(options.refresh,false);
res=response();post({params:{jobId:'job'},body:{refresh:'yes'}},res);assert.equal(res.code,400);
scheduled={scheduled:true,reason:'queued',refreshId:'new-id'};res=response();post({params:{jobId:'job'},body:{refresh:true}},res);
assert.equal(res.body.refreshId,'new-id');assert.equal(options.refresh,true);
scheduled={reason:'already scheduled'};res=response();post({params:{jobId:'job'},body:{refresh:true}},res);assert.equal(res.code,409);
scheduled={reason:'primary analysis unavailable'};res=response();post({params:{jobId:'job'}},res);assert.equal(res.code,409);
res=response();get({params:{jobId:'job'}},res);assert.equal(res.body.sidecar,summary);
clubCache={dtlClubPointsV2:summary,dtlClubRefresh:{id:'old',status:'running'}};
res=response();get({params:{jobId:'job'}},res);assert.equal(res.body.refresh.status,'interrupted');
routes.activeDtlClubPointsV2.set('job',null);res=response();get({params:{jobId:'job'}},res);assert.equal(res.body.refresh.status,'interrupted');
routes.activeDtlClubPointsV2.set('job','old');res=response();get({params:{jobId:'job'}},res);assert.equal(res.body.refresh.status,'running');
console.log('club review refresh and status routes passed');
