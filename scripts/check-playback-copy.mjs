import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const {createReviewVideo}=createRequire(import.meta.url)('../storage/reviewVideo');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-copy-'));
try {
 const source=path.join(root,'source.mp4'),other=path.join(root,'other.mp4');
 await fs.writeFile(source,'original');await fs.writeFile(other,'other');
 let calls=0,release,entered;
 const began=new Promise(resolve=>entered=resolve);
 const gate=new Promise(resolve=>release=resolve);
 const playback=createReviewVideo({cacheDir:path.join(root,'cache'),runCommand:async(cmd,args)=>{
  calls++;assert.equal(cmd,'ffmpeg');assert.equal(args[args.indexOf('-enc_time_base')+1],'-1');assert.equal(args[args.indexOf('-fps_mode')+1],'passthrough');entered();await gate;await fs.writeFile(args.at(-1),'playback');
 }});
 const first=playback(source);await began;const second=playback(source);
 assert.equal(await playback(other),other,'only one conversion may run');release();
 const [a,b]=await Promise.all([first,second]);assert.equal(a,b);assert.notEqual(a,source);assert.equal(calls,1);
 assert.equal(await playback(source),a);assert.equal(calls,1);
 assert.equal(await fs.readFile(source,'utf8'),'original');
 await fs.appendFile(source,'changed');assert.notEqual(await playback(source),a);assert.equal(calls,2);
 const fixed=new Date('2020-01-01T00:00:00.000Z');
 await fs.writeFile(source,'originalX');await fs.utimes(source,fixed,fixed);
 const beforeStat=await fs.stat(source), beforeCopy=await playback(source);
 const replacement=path.join(root,'replacement.mp4');await fs.writeFile(replacement,'replacedY');await fs.utimes(replacement,fixed,fixed);
 await fs.rename(replacement,source);const afterStat=await fs.stat(source);
 assert.equal(afterStat.size,beforeStat.size);assert.equal(afterStat.mtimeMs,beforeStat.mtimeMs);
 assert.notEqual(afterStat.ino,beforeStat.ino);
 assert.notEqual(await playback(source),beforeCopy,'same-size replacement with preserved mtime must not reuse an old playback copy');
 const failed=createReviewVideo({cacheDir:path.join(root,'failure'),runCommand:async()=>{throw Error('codec unavailable');}});
 assert.equal(await failed(source),source,'failure retains original playback');
 let conversions=0,probes=0;
 const verified=createReviewVideo({cacheDir:path.join(root,'verified'),runCommand:async(cmd,args)=>{
  if(cmd==='ffmpeg'){conversions++;await fs.writeFile(args.at(-1),'playback');return {stdout:''};}
  assert.equal(cmd,'ffprobe');probes++;
  return {stdout:JSON.stringify({frames:[0,.033,.066,.099].map(t=>({best_effort_timestamp_time:String(t)}))})};
 }});
 const clock=[0,33,66,99];
 const [checked,joined]=await Promise.all([verified(source,clock),verified(source,clock)]);
 assert.notEqual(checked,source);assert.equal(checked,joined);assert.equal(conversions,1);assert.equal(probes,1);
 assert.equal(await verified(source,clock),checked);assert.equal(probes,1,'verified timing is reused for range requests');
 assert.equal(await verified(source,[0,33,66,150]),source,'different playback timestamps must fall back to the analysis input');
 assert.equal(await verified(source,[0,33,66,150]),source);assert.equal(probes,2,'failed timing is not repeatedly probed');
 assert.equal(await verified(source,[0,33,33,99]),source,'invalid expected clock must not use a copy');
 assert.equal(await verified(source,[0,33,66,30001]),source,'out-of-scope duration must not use a copy');
 assert.equal(await verified(source,Array.from({length:7201},(_,i)=>i)),source,'unbounded clocks must not trigger a probe');
 console.log('playback copy identity, cache, deduplication, CPU bound, timestamps and fallback checks passed');
}finally{await fs.rm(root,{recursive:true,force:true});}
