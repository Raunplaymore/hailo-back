import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const express = require('express');
const {matchesVideoIdentity} = require('../store/impactReviewCache');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-video-'));
const converted = path.join(root, '.converted');
fs.mkdirSync(converted);
const file = path.join(converted, 'converted.mp4');
const bytes = Buffer.from('known converted video bytes');
fs.writeFileSync(file, bytes);
const other = path.join(converted, 'another.mp4');
fs.writeFileSync(other, 'newly associated video');
let identity = fs.statSync(file), changeDuringCopy = false, frames = [0, 33, 66, 99], receivedClock;
const copy = path.join(root, 'playback.mp4'), small = Buffer.from('small playback bytes');
fs.writeFileSync(copy, small);
const otherCopy = path.join(root, 'another-playback.mp4');
fs.writeFileSync(otherCopy, 'different playback');
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const route = source.slice(source.indexOf("app.get('/api/analyze/:jobId/review-video'"), source.indexOf("app.post('/api/analyze/:jobId/impact-review'"));
const app = express();
const hash = 'a'.repeat(64);
vm.runInNewContext(route, {
  app, fs, path, matchesVideoIdentity, reviewVideoPath: async (input, expected) => {
    if (input === file) receivedClock = expected;
    if (changeDuringCopy) await fs.promises.appendFile(file, ' changed during conversion');
    return input === file ? copy : otherCopy;
  },
  impactReviews: { read: (id) => id === 'known' ? { inputPath: file, dev: identity.dev, ino: identity.ino, size: identity.size, mtimeMs: identity.mtimeMs, ctimeMs: identity.ctimeMs, result: { videoSha256: hash, frameTimesMs: frames } } : null },
  resolveReviewReference: (id, value) => id === 'known' && value === hash ? { inputPath: file, dev: identity.dev, ino: identity.ino, size: identity.size, mtimeMs: identity.mtimeMs, ctimeMs: identity.ctimeMs, result: { videoSha256: hash, frameTimesMs: frames } } : null,
  shotStore: { getShotByJobId: (id) => id === 'known' ? { metadata: { analysisInput: { path: other } } } : null },
});
const server = app.listen(0, '127.0.0.1');
try {
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/analyze`;
  for (const query of [`?v=${hash}`]) {
    const response = await fetch(`${base}/known/review-video${query}`, { headers: { Range: 'bytes=0-4' } });
    assert.equal(response.status, 206, 'known file in .converted must support video range requests');
    assert.match(response.headers.get('content-type'), /video\/mp4/);
    assert.equal(response.headers.get('content-range'), `bytes 0-4/${small.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), small.subarray(0, 5));
  }
  const full = await fetch(`${base}/known/review-video?v=${hash}`);
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), small);
  assert.deepEqual(Array.from(receivedClock), frames, 'bound playback must validate its frame clock');
  const unbound = await fetch(`${base}/known/review-video`);
  assert.deepEqual(Buffer.from(await unbound.arrayBuffer()), Buffer.from('different playback'));
  const original = await fetch(`${base}/known/review-video?quality=original&v=${hash}`);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  assert.equal((await fetch(`${base}/known/review-video?v=wrong`)).status, 409);
  frames = null;assert.equal((await fetch(`${base}/known/review-video?v=${hash}`)).status,409);frames = [0, 33, 66, 99];
  await fs.promises.appendFile(file, ' changed after analysis');
  assert.equal((await fetch(`${base}/known/review-video?v=${hash}`)).status, 409, 'changed analysis source must not be served as the old candidate');
  assert.equal((await fetch(`${base}/known/review-video?quality=original&v=${hash}`)).status, 409);
  assert.equal((await fetch(`${base}/known/review-video?v=`)).status, 409, 'empty identity is not an unbound request');
  await fs.promises.writeFile(file, bytes); identity = fs.statSync(file); changeDuringCopy = true;
  assert.equal((await fetch(`${base}/known/review-video?v=${hash}`)).status, 409, 'source changing during playback preparation must not be served');
  assert.equal((await fetch(`${base}/missing/review-video`)).status, 404);
  console.log('converted review video full/range/identity checks passed');
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
