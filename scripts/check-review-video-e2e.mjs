// Pi integration check on a disposable copy; the supplied source is never modified.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url), exec = promisify(execFile);
const express = require('express');
const {createImpactReviewCache, matchesVideoIdentity} = require('../store/impactReviewCache');
const {createReviewVideo} = require('../storage/reviewVideo');
const fixture = process.argv[2];
if (!fixture || !fs.statSync(fixture).isFile()) throw new Error('Expected an existing video fixture');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hailo-review-e2e-'));
const converted = path.join(root, '.converted'); fs.mkdirSync(converted);
const video = path.join(converted, 'input.mp4'); fs.copyFileSync(fixture, video);
const fixed = new Date('2020-01-01T00:00:00.000Z'); fs.utimesSync(video, fixed, fixed);
let server;
try {
  const probe = await exec('ffprobe', ['-v','error','-select_streams','v:0','-show_frames','-show_entries',
    'frame=best_effort_timestamp_time','-of','json',video], {timeout:30000, maxBuffer:16*1024*1024});
  const raw = JSON.parse(probe.stdout).frames.map(frame => Number(frame.best_effort_timestamp_time) * 1000);
  const times = raw.map(time => Math.round((time - raw[0]) * 1000) / 1000);
  assert.ok(times.length >= 4 && times.every((time, i) => Number.isFinite(time) && (i === 0 || time > times[i-1])));
  const digest = crypto.createHash('sha256').update(fs.readFileSync(video)).digest('hex');
  const result = {ok:true,jobId:'known',status:'reference_candidate',timingRevision:3,
    modelSha256:'70b338b519565f870ed1fce044a0453f828773e53b9fa9d024391b3b4cf57733',videoSha256:digest,
    publicValue:null,automaticCoachingReady:false,appliedToPrimary:false,inputScopeConfirmed:false,
    frameTimesMs:times,candidate:{frameIndex:1,timeMs:times[1]}};
  const impactReviews = createImpactReviewCache({dataDir:root,run:async()=>result});
  await impactReviews.schedule('known',video);
  let probes=0, conversions=0;
  const runCommand = async (command,args,options) => {
    if (command === 'ffprobe') probes++; if (command === 'ffmpeg') conversions++;
    return exec(command,args,{timeout:options.timeoutMs,maxBuffer:16*1024*1024});
  };
  const reviewVideoPath = createReviewVideo({cacheDir:path.join(root,'preview'),runCommand});
  const app = express();
  const source = fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const route = source.slice(source.indexOf("app.get('/api/analyze/:jobId/review-video'"), source.indexOf("app.post('/api/analyze/:jobId/club-review'"));
  assert.ok(route.startsWith("app.get('/api/analyze/:jobId/review-video'"));
  vm.runInNewContext(route,{app,fs,path,impactReviews,reviewVideoPath,matchesVideoIdentity,
    resolveReviewReference:(id,hash)=>{const entry=impactReviews.read(id);return entry?.result?.videoSha256===hash?entry:null;},
    shotStore:{getShotByJobId:id=>id==='known'?{metadata:{analysisInput:{path:video}}}:null}});
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/analyze/known/review-video?v=${digest}`;
  for (let i=0;i<2;i++) {
    const response=await fetch(url,{headers:{Range:'bytes=0-99'}});
    assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,100);
  }
  assert.equal(conversions,1);assert.equal(probes,1,'verified frame clock is reused');
  const old=fs.statSync(video), bytes=fs.readFileSync(video), replacement=path.join(root,'replacement.mp4');
  bytes[bytes.length-1]^=1;fs.writeFileSync(replacement,bytes);fs.utimesSync(replacement,fixed,fixed);fs.renameSync(replacement,video);
  const changed=fs.statSync(video);assert.equal(changed.size,old.size);assert.equal(changed.mtimeMs,old.mtimeMs);assert.notEqual(changed.ino,old.ino);
  assert.equal((await fetch(url)).status,409,'replaced video must not be served under the old hash');
  console.log(JSON.stringify({frames:times.length,rangeRequests:2,conversions,probes,staleVideoRejected:true}));
} finally {
  if (server) await new Promise(resolve=>server.close(resolve));
  fs.rmSync(root,{recursive:true,force:true});
}
