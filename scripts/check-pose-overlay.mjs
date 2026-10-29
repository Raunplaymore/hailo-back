import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {matchesVideoIdentity} from '../store/impactReviewCache.js';

const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf("app.get('/api/analyze/:jobId/pose-overlay'"),end=source.indexOf("app.post('/api/analyze/:jobId/practice-review'",start);
assert.ok(start>=0 && end>start);
let handler,videoChange=0,bodyChange=0,analysisStatus='done',timingRevision=3,clock=[0,33,67,100],calls=[];
const video={dev:1,ino:2,size:100,mtimeMs:10,ctimeMs:20};
const body={dev:1,ino:3,size:200,mtimeMs:30,ctimeMs:40};
let upstream={ok:true,json:{ok:true,jobId:'job',status:'ready',timeSource:'video_pts',poseFrames:[
  {frame:0,timeMs:0,keypoints:{left_wrist:[.2,.3,.9]}},{frame:1,timeMs:33,keypoints:{}},
  {frame:2,timeMs:67,keypoints:{left_wrist:[.4,.3,.9]}}]}};
let mutate='';
vm.runInNewContext(source.slice(start,end),{
  app:{get:(_path,fn)=>{handler=fn;}},
  shotStore:{getShotByJobId:id=>id==='job'?{status:'done',metadata:{bodyPath:'/data/body.json'}}:null},
  readAnalysisCache:()=>({status:analysisStatus}),
  impactReviews:{read:()=>({...video,inputPath:'/uploads/clip.mp4',result:{videoSha256:'a'.repeat(64),timingRevision,frameTimesMs:clock}})},
  fs:{existsSync:()=>true,statSync:path=>path==='/data/body.json'?{...body,ctimeMs:body.ctimeMs+bodyChange}:{...video,ctimeMs:video.ctimeMs+videoChange}},
  matchesVideoIdentity,bodyArtifactPath:()=>'/data/fallback.json',inferUrl:p=>p,
  inferFetchJson:async(url,options)=>{calls.push({url,...options});if(mutate==='video')videoChange++;if(mutate==='body')bodyChange++;return upstream;},
});
async function request(v='a'.repeat(64),jobId='job'){
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.data=value;return this;}};
  await handler({params:{jobId},query:{v}},res);return res;
}
assert.equal((await request('bad')).statusCode,400);
assert.equal((await request('a'.repeat(64),'../escape')).statusCode,400);
assert.equal((await request('a'.repeat(64),'missing')).statusCode,404);
assert.equal((await request('b'.repeat(64))).statusCode,409);
analysisStatus='running';assert.equal((await request()).statusCode,409);analysisStatus='done';
timingRevision=2;assert.equal((await request()).statusCode,409);timingRevision=3;
clock=[0,33,33,100];assert.equal((await request()).statusCode,409);clock=[0,33,67,100];
assert.equal(calls.length,0,'unverified requests never reach inference');
const valid=await request();assert.equal(valid.statusCode,200);assert.equal(valid.data.videoSha256,'a'.repeat(64));
assert.equal(valid.data.poseFrames[1].keypoints && Object.keys(valid.data.poseFrames[1].keypoints).length,0);
assert.equal(calls[0].url,'/v1/pose-overlay');assert.equal(calls[0].body.inputPath,'/uploads/clip.mp4');assert.equal(calls[0].body.bodyPath,'/data/body.json');
for(const changed of [
  {jobId:'other'}, {timeSource:'estimated'}, {status:'ready',poseFrames:[]},
  {poseFrames:[{frame:1,timeMs:34,keypoints:{}}]}, {poseFrames:[{frame:1,timeMs:33,keypoints:{}},{frame:1,timeMs:33,keypoints:{}}]},
  {status:'ready',poseFrames:[{frame:0,timeMs:0,keypoints:{}}]},
  {poseFrames:[{frame:0,timeMs:0,keypoints:{left_wrist:[.2,.3,NaN]}}]}, {poseFrames:[{frame:0,timeMs:0,keypoints:{unknown:[.2,.3,.9]}}]},
]) {
  const old=upstream;upstream={ok:true,json:{...old.json,...changed}};assert.equal((await request()).statusCode,502);upstream=old;
}
mutate='video';assert.equal((await request()).statusCode,409);videoChange=0;
mutate='body';assert.equal((await request()).statusCode,409);bodyChange=0;mutate='';
upstream={ok:true,json:{ok:true,jobId:'job',status:'unavailable',timeSource:'video_pts',poseFrames:[]}};
assert.equal((await request()).data.status,'unavailable');
clock=Array.from({length:7200},(_,i)=>i*4);
const joints=['nose',...['left','right'].flatMap(side=>['shoulder','elbow','wrist','hip','knee','ankle'].map(joint=>`${side}_${joint}`))];
const densePoints=Object.fromEntries(joints.map(name=>[name,[.2,.3,.9]]));
upstream={ok:true,json:{ok:true,jobId:'job',status:'ready',timeSource:'video_pts',poseFrames:clock.map((timeMs,frame)=>({frame,timeMs,keypoints:frame===3599?{}:densePoints}))}};
assert.equal((await request()).data.poseFrames.length,7200,'the supported 30-second frame range must not silently drop gaps');
upstream={ok:false,status:422};assert.equal((await request()).statusCode,422);
console.log('pose overlay: bound video, actual frame times, missing observations and file races passed');
