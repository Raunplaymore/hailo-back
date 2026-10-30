import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), express=require('express');
const {createImpactReviewCache,matchesVideoIdentity}=require('../store/impactReviewCache.js');
const {selectVideoReference}=require('../store/videoClock.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'impact-pose-integration-'));
const video=path.join(root,'video.mp4'),body=path.join(root,'body.json'),replacement=path.join(root,'replacement.json');
const digest='a'.repeat(64), times=[0,100,250,400,550,700], model='70b338b519565f870ed1fce044a0453f828773e53b9fa9d024391b3b4cf57733';
fs.writeFileSync(video,'video');fs.writeFileSync(body,JSON.stringify({frame:4}));
let runs=0, changeBodyDuringCoaching=false, upstreamCalls=0;
const impactReviews=createImpactReviewCache({dataDir:root,run:async(jobId,_input,pose)=>{
  runs++;const index=JSON.parse(fs.readFileSync(pose,'utf8')).frame;
  return {ok:true,jobId,status:'reference_candidate',timingRevision:3,modelSha256:model,videoSha256:digest,publicValue:null,
    automaticCoachingReady:false,appliedToPrimary:false,inputScopeConfirmed:false,candidate:{frameIndex:index,timeMs:times[index]},frameTimesMs:times};
}});
const app=express();app.use(express.json());
const shot={status:'done',metadata:{analysisInput:{path:video},bodyPath:body}};
const shotStore={getShotByJobId:id=>id==='job'?shot:null};
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const cut=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const context={app,fs,path,shotStore,impactReviews,matchesVideoIdentity,selectVideoReference,
  manualVideoClocks:{read:()=>null},readAnalysisCache:()=>null,bodyArtifactPath:()=>body,inferUrl:p=>p,
  inferFetchJson:async(_url,options)=>{upstreamCalls++;if(changeBodyDuringCoaching){fs.writeFileSync(replacement,JSON.stringify({frame:4}));fs.renameSync(replacement,body);}
    return {ok:true,json:{ok:true,impactMs:options.body.impactMs}};}};
vm.runInNewContext(cut('function resolveReviewReference(' ,"app.get('/api/analyze/:jobId/video-clock'"),context);
vm.runInNewContext(cut("app.post('/api/analyze/:jobId/practice-review'","app.get('/api/analyze/:jobId',"),context);
const server=app.listen(0,'127.0.0.1');
try {
  await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/analyze/job/practice-review`;
  const post=body=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const request={mode:'coaching',addressMs:100,comparisonMs:470,viewpoint:'down_the_line',videoSha256:digest};
  await impactReviews.schedule('job',video,body);
  assert.equal((await post(request)).status,200);
  fs.writeFileSync(replacement,JSON.stringify({frame:5}));fs.renameSync(replacement,body);
  const before=upstreamCalls;
  assert.equal((await post(request)).status,409,'old automatic candidate must not accompany a replaced pose');
  assert.equal(upstreamCalls,before,'stale inputs must not reach inference');
  assert.equal((await post({...request,impactFrameIndex:5,comparisonMs:620})).status,200,'manual frame selection stays available');
  await impactReviews.schedule('job',video,body);assert.equal(runs,2);
  const fresh=await post({...request,comparisonMs:620});assert.equal(fresh.status,200);
  assert.equal((await fresh.json()).impactMs,700,'new automatic candidate is passed through');
  changeBodyDuringCoaching=true;
  assert.equal((await post({...request,comparisonMs:620})).status,409,'body changes during coaching must not return stale observations');
  console.log('impact cache and coaching route preserve pose identity and manual selection');
} finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
