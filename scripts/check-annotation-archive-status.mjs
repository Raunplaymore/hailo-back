import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import {createHash} from 'node:crypto';
const source=fs.readFileSync('server.js','utf8');
const start=source.indexOf("app.get('/api/debug/infer/:jobId/annotation',");
const end=source.indexOf("\napp.get('/api/debug/swing-tracking/annotations'",start);
assert.ok(start>=0&&end>start);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'annotation-archive-status-'));let handler;
const annotation={jobId:'job1',updatedAt:'new-revision'};
const nasArchive={enabled:true};
const context={fs,path,console,createHash,nasArchive,isSafeJobId:id=>/^[a-z0-9]+$/.test(id),swingTrackingAnnotations:{annotationDir:root,load:async()=>annotation},swingTrackingArchiveRecordPath:id=>path.join(root,id+'.status.json'),app:{get:(_path,fn)=>handler=fn}};
vm.runInNewContext(source.slice(start,end),context);
async function read(id='job1'){const response={statusCode:200,status(n){this.statusCode=n;return this},json(data){this.data=data;return this}};await handler({params:{jobId:id}},response);return response;}
try{
 assert.equal((await read()).data.archive.state,'unknown');
 const contents=JSON.stringify(annotation);fs.writeFileSync(path.join(root,'job1.json'),contents);const sha256=createHash('sha256').update(contents).digest('hex');
 const write=(revision,state,hash=sha256)=>fs.writeFileSync(path.join(root,'job1.status.json'),JSON.stringify({annotationUpdatedAt:revision,archive:{state,artifacts:hash?[{artifact:'annotation',sha256:hash}]:[]}}));
 write('old-revision','stored');assert.equal((await read()).data.archive.state,'unknown');
 for(const state of ['pending','uploading','retrying','failed','stored']){write('new-revision',state);assert.equal((await read()).data.archive.state,state);}
 write('new-revision','stored','incorrect');assert.equal((await read()).data.archive.state,'unknown');
 write('new-revision','stored',null);assert.equal((await read()).data.archive.state,'failed');
 write('new-revision','bogus');assert.equal((await read()).data.archive.state,'unknown');
 nasArchive.enabled=false;assert.equal((await read()).data.archive.state,'disabled');
 assert.equal((await read('../unsafe')).statusCode,400);
 console.log('annotation archive status: revision, failure, disabled and invalid identity checks passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
