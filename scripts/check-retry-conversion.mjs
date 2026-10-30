import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const root = await mkdtemp(path.join(tmpdir(), 'retry-conversion-'));
try {
  const source = path.join(root, 'video.mov');
  await writeFile(source, 'source');
  await mkdir(path.join(root, '.converted'));
  const stats = fs.statSync(source);
  const previous = path.join(root, '.converted', `video-${stats.mtimeMs}-${stats.size}.mp4`);
  await writeFile(previous, 'partial');
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf('async function prepareVideoForAnalysis(');
  const end = server.indexOf('\nfunction toBoolean(', start);
  assert.ok(start >= 0 && end > start);
  let conversions = 0;
  const context = {fs, path, uploadDir:root, ensureFfmpegAvailability:async()=>({ffmpeg:true}),
    getVideoCodecName:async()=> 'h264', runCommand:async(_command,args)=>{conversions++; await writeFile(args.at(-1),'new conversion');}};
  const prepare = vm.runInNewContext(`${server.slice(start,end)}\nprepareVideoForAnalysis`, context);
  const retried = await prepare(source, 'video.mov', 'retry-job');
  assert.equal(retried.ok, true); assert.notEqual(retried.path, previous);
  assert.equal(await readFile(previous, 'utf8'), 'partial', 'prior conversion must remain untouched');
  assert.equal(await readFile(retried.path, 'utf8'), 'new conversion'); assert.equal(conversions, 1);
  const legacy = await prepare(source, 'video.mov');
  assert.equal(legacy.path, previous, 'ordinary analyses retain the existing cache behavior');
  await assert.rejects(prepare(source, 'video.mov', '../invalid'), /Invalid retry job ID/);
  console.log('retry conversion uses a new path and preserves prior conversion files');
} finally {
  await rm(root, {recursive:true,force:true});
}
