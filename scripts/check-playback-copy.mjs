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
 const failed=createReviewVideo({cacheDir:path.join(root,'failure'),runCommand:async()=>{throw Error('codec unavailable');}});
 assert.equal(await failed(source),source,'failure retains original playback');
 console.log('playback copy identity, cache, deduplication, CPU bound, timestamps and fallback checks passed');
}finally{await fs.rm(root,{recursive:true,force:true});}
