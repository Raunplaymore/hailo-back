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
let post, get, shot = { metadata: {} }, scheduled = { scheduled: true, reason: 'queued' };
const routes = vm.createContext({ app: { post: (_p, h) => {post=h;}, get: (_p, h) => {get=h;} },
  shotStore: { getShotByJobId: () => shot }, scheduleDtlClubPointsV2Sidecar: () => scheduled,
  readAnalysisCache: () => ({dtlClubPointsV2: summary}) });
vm.runInContext(source.slice(routeStart,routeEnd),routes);
const response = () => ({ code: 200, status(c) {this.code=c;return this;}, sendStatus(c) {this.code=c;return this;}, json(value) {this.body=value;return this;} });
let res=response();post({params:{jobId:'../bad'}},res);assert.equal(res.code,400);
shot=null;res=response();post({params:{jobId:'job'}},res);assert.equal(res.code,404);
shot={metadata:{handedness:'left'}};res=response();post({params:{jobId:'job'}},res);assert.equal(res.code,422);
shot={metadata:{}};res=response();post({params:{jobId:'job'}},res);assert.equal(res.code,202);
scheduled={reason:'primary analysis unavailable'};res=response();post({params:{jobId:'job'}},res);assert.equal(res.code,409);
res=response();get({params:{jobId:'job'}},res);assert.equal(res.body.sidecar,summary);
console.log('club review refresh and status routes passed');
