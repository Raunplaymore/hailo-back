import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const express = require('express');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-video-'));
const converted = path.join(root, '.converted');
fs.mkdirSync(converted);
const file = path.join(converted, 'converted.mp4');
const bytes = Buffer.from('known converted video bytes');
fs.writeFileSync(file, bytes);
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const route = source.slice(source.indexOf("app.get('/api/analyze/:jobId/review-video'"), source.indexOf("app.post('/api/analyze/:jobId/impact-review'"));
const app = express();
const hash = 'a'.repeat(64);
vm.runInNewContext(route, {
  app, fs, path,
  impactReviews: { read: (id) => id === 'known' ? { inputPath: file, result: { videoSha256: hash } } : null },
  shotStore: { getShotByJobId: (id) => id === 'known' ? { metadata: { analysisInput: { path: file } } } : null },
});
const server = app.listen(0, '127.0.0.1');
try {
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/analyze`;
  for (const query of ['', `?v=${hash}`]) {
    const response = await fetch(`${base}/known/review-video${query}`, { headers: { Range: 'bytes=0-4' } });
    assert.equal(response.status, 206, 'known file in .converted must support video range requests');
    assert.match(response.headers.get('content-type'), /video\/mp4/);
    assert.equal(response.headers.get('content-range'), `bytes 0-4/${bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, 5));
  }
  const full = await fetch(`${base}/known/review-video?v=${hash}`);
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  assert.equal((await fetch(`${base}/known/review-video?v=wrong`)).status, 409);
  assert.equal((await fetch(`${base}/missing/review-video`)).status, 404);
  console.log('converted review video full/range/identity checks passed');
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
