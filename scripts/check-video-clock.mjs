import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {createVideoClock,selectVideoReference} = createRequire(import.meta.url)('../store/videoClock.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'video-clock-'));
try {
  const file=path.join(root,'clip.mp4');fs.writeFileSync(file,'original video');
  let probes=0, times=[0,16.667,33.333,50], frameCount=4;
  const clock=createVideoClock({probe:async()=>{probes++;return {times,frameCount};},hash:async()=> 'a'.repeat(64)});
  const result=await clock.prepare('job',file);
  assert.deepEqual(result.frameTimesMs,times);
  assert.equal((await clock.prepare('job',file)),result,'same unchanged video should reuse the clock');
  assert.equal(probes,1);
  assert.equal(clock.read('job','a'.repeat(64)).inputPath,file);
  assert.equal(clock.read('job','b'.repeat(64)),null);
  assert.equal(result.candidate,undefined,'clock must not manufacture an impact candidate');
  const manual=clock.read('job','a'.repeat(64));
  const previous={...manual,result:{...manual.result,timingRevision:2,candidate:{timeMs:33}}};
  assert.equal(selectVideoReference(previous,manual,'a'.repeat(64),{requireRevision3:true}),manual);
  assert.equal(selectVideoReference(previous,manual,'a'.repeat(64)),previous);
  assert.equal(selectVideoReference(previous,manual,'b'.repeat(64)),null);
  await assert.rejects(clock.prepare('../invalid',file));
  fs.appendFileSync(file,' changed');
  assert.equal(selectVideoReference(previous,manual,'a'.repeat(64)),null,'changed source invalidates both references');
  await clock.prepare('job',file);assert.equal(probes,2,'changed input must be reprobed');
  for (const broken of [[],[0,33,33,99],[0,33,NaN,99],[0,33,67,30001],Array.from({length:7201},(_,i)=>i)]) {
    const bad=createVideoClock({probe:async()=>({times:broken,frameCount:broken.length}),hash:async()=> 'a'.repeat(64)});
    await assert.rejects(bad.prepare('bad',file));
    assert.equal(bad.read('bad','a'.repeat(64)),null);
  }
  const mismatch=createVideoClock({probe:async()=>({times:[0,33,66,99],frameCount:5}),hash:async()=> 'a'.repeat(64)});
  await assert.rejects(mismatch.prepare('bad',file),'decode count must match the complete source');
  const race=createVideoClock({probe:async()=>{fs.appendFileSync(file,'race');return {times:[0,33,66,99],frameCount:4};},hash:async()=> 'a'.repeat(64)});
  await assert.rejects(race.prepare('race',file));assert.equal(race.read('race','a'.repeat(64)),null);
  let release;const gate=new Promise(done=>release=done);let running=0;
  const queued=createVideoClock({probe:async()=>{running++;await gate;return {times:[0,33,66,99],frameCount:4};},hash:async()=> 'a'.repeat(64)});
  const a=queued.prepare('a',file),duplicate=queued.prepare('a',file);
  assert.equal(a,duplicate,'same request shares in-flight work');
  const waiting=['b','c','d'].map(id=>queued.prepare(id,file));
  await assert.rejects(queued.prepare('e',file),/busy/);
  release();await Promise.all([a,...waiting]);assert.equal(running,4);
  console.log('video clock identity, bounds, cache, race and bounded queue checks passed');
} finally {fs.rmSync(root,{recursive:true,force:true});}
