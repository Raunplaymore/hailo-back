import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import cacheModule from '../store/impactReviewCache.js';
const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const route=source.slice(source.indexOf("app.post('/api/analyze/:jobId/practice-review'"),source.indexOf("app.get('/api/analyze/:jobId',"));
let fileSize=100, fileChange=40, analysisCache=null, timingRevision=3, frameTimes=[0,100,250,400,550,700];
let changeDuringInference=false;
let handler, upstream={ok:true,json:{ok:true,status:'withheld'}}, calls=[];
const shot={status:'done',metadata:{analysisInput:{path:'/uploads/original.mp4'}}};
vm.runInNewContext(route,{
 app:{post:(_path,fn)=>handler=fn}, fs:{existsSync:()=>true,statSync:()=>({dev:1,ino:7,size:fileSize,mtimeMs:20,ctimeMs:fileChange})}, matchesVideoIdentity:cacheModule.matchesVideoIdentity,
 shotStore:{getShotByJobId:id=>id==='known'?shot:null},
 impactReviews:{read:()=>({inputPath:'/uploads/converted.mp4',dev:1,ino:7,size:100,mtimeMs:20,ctimeMs:40,result:{timingRevision,videoSha256:'a'.repeat(64),frameTimesMs:frameTimes,candidate:{timeMs:550}}})},
 readAnalysisCache:()=>analysisCache,
 bodyArtifactPath:id=>`/data/body/${id}.json`,inferUrl:p=>p,
 inferFetchJson:async(url,options)=>{calls.push({url,...options});if(changeDuringInference)fileChange=41;return upstream;},
});
const valid={addressMs:100,comparisonMs:500,viewpoint:'down_the_line',confirmedFrames:true};
async function request(body=valid,id='known'){
 const res={statusCode:200,status(s){this.statusCode=s;return this;},json(data){this.data=data;return this;}};
 await handler({params:{jobId:id},body},res);return res;
}
for(const patch of [{addressMs:-1},{comparisonMs:100},{comparisonMs:30001},{addressMs:'100'},{comparisonMs:Infinity},{confirmedFrames:false},{confirmedFrames:1},{viewpoint:'face_on'},{videoSha256:'oops'}]) assert.equal((await request({...valid,...patch})).statusCode,400);
assert.equal((await request(valid,'../escape')).statusCode,400);
assert.equal((await request(valid,'missing')).statusCode,404);
assert.equal(calls.length,0);
await request({...valid,inputPath:'/etc/passwd',bodyPath:'/etc/passwd'});
assert.equal(calls[0].body.inputPath,'/uploads/original.mp4');assert.equal(calls[0].body.bodyPath,'/data/body/known.json');
await request({...valid,videoSha256:'a'.repeat(64)});assert.equal(calls[1].body.inputPath,'/uploads/converted.mp4');
assert.equal((await request({...valid,videoSha256:'b'.repeat(64)})).statusCode,409);
fileSize=101;assert.equal((await request({...valid,videoSha256:'a'.repeat(64)})).statusCode,409);fileSize=100;
fileChange=41;assert.equal((await request({...valid,videoSha256:'a'.repeat(64)})).statusCode,409);fileChange=40;
shot.status='running';assert.equal((await request()).statusCode,409);
analysisCache={status:'done'};assert.equal((await request()).statusCode,200);
shot.status='done';analysisCache={status:'running'};assert.equal((await request()).statusCode,409);
analysisCache={status:'pending'};assert.equal((await request()).statusCode,409);analysisCache=null;
shot.metadata.viewpoint='face_on';assert.equal((await request()).statusCode,422);delete shot.metadata.viewpoint;
upstream={ok:false,status:422,json:{detail:'source mismatch'}};assert.equal((await request()).data.error,'source mismatch');
await request({...valid, mode:'preview',confirmedFrames:false,videoSha256:'a'.repeat(64),impactMs:99999});
assert.equal(calls.at(-1).url,'/v1/practice-preview');
assert.equal(calls.at(-1).body.confirmedFrames,undefined);
assert.equal(calls.at(-1).body.impactMs,550,'use stored impact candidate, never the client phase');
assert.equal((await request({...valid,confirmedFrames:false})).statusCode,400);
assert.equal((await request({...valid,mode:'coaching',videoSha256:undefined})).statusCode,400,'automatic coaching must identify its video');
await request({...valid,mode:'coaching',confirmedFrames:false,videoSha256:'a'.repeat(64),impactMs:9999});
assert.equal(calls.at(-1).url,'/v1/coaching-review');
assert.equal(calls.at(-1).body.impactMs,550,'coaching also uses only the stored candidate');
assert.equal(calls.at(-1).body.confirmedFrames,undefined);
const selected={...valid,mode:'coaching',confirmedFrames:false,videoSha256:'a'.repeat(64),impactFrameIndex:5,comparisonMs:620};
upstream={ok:true,json:{ok:true,status:'withheld'}};
assert.equal((await request(selected)).statusCode,200);
assert.equal(calls.at(-1).body.impactMs,700,'selected frame time must come from the verified video cache');
assert.equal(calls.at(-1).body.comparisonMs,620);
assert.equal(calls.at(-1).body.impactFrameIndex,undefined,'frame selection is not forwarded as a label');
for(const index of [-1,1.5,'5',null,6,99999]) assert.equal((await request({...selected,impactFrameIndex:index})).statusCode,400);
assert.equal((await request({...selected,mode:'preview'})).statusCode,400);
assert.equal((await request({...selected,comparisonMs:621.1})).statusCode,400);
assert.equal((await request({...selected,addressMs:500})).statusCode,400);
assert.equal((await request({...selected,videoSha256:'b'.repeat(64)})).statusCode,409);
const beforeInvalidFrames=calls.length;
for(const times of [undefined,[0,100,100,400,550,700],[0,100,250,400,550,NaN]]) {
 frameTimes=times;assert.equal((await request(selected)).statusCode,409);
}
assert.equal(calls.length,beforeInvalidFrames,'invalid frame maps must not reach inference');
frameTimes=[0,100,250,400,550,700];
changeDuringInference=true;assert.equal((await request(selected)).statusCode,409,'changed video must not return an observation');
changeDuringInference=false;fileChange=40;
timingRevision=undefined;
const beforeStale=calls.length;
assert.equal((await request({...valid,mode:'coaching',videoSha256:'a'.repeat(64)})).statusCode,409,'old frame mapping must be recomputed before coaching');
timingRevision=2;
assert.equal((await request({...valid,mode:'coaching',videoSha256:'a'.repeat(64)})).statusCode,409,'revision 2 must be recomputed before coaching');
assert.equal(calls.length,beforeStale,'stale timing must not reach inference');
timingRevision=3;
upstream={ok:false,status:409,json:{detail:'busy'}};
assert.equal((await request({...valid,mode:'coaching',videoSha256:'a'.repeat(64)})).statusCode,409,'bounded inference exposes retryable busy state');
console.log('practice review routing, input identity and failure checks passed');
