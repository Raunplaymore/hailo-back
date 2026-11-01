import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const cut = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'delete route must exist');
  return source.slice(first, last);
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hailo-delete-check-'));
const uploadDir = path.join(root, 'uploads'), dataDir = path.join(root, 'data');
const inferDebugFrameDir = path.join(dataDir, 'debug', 'infer-frames');
const label = path.join(dataDir, 'annotations', 'keep.json');
const unrelated = path.join(inferDebugFrameDir, 'another-job', 'frame.jpg');
const jobFrame = path.join(inferDebugFrameDir, 'job.1', 'frame.jpg');
const write = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); };
let handler, deleted = false;
let nasFails = false;
const nasCalls = [];
const shot = { jobId: 'job.1', media: { filename: 'video.mp4' } };
const context = {
  fs, path, uploadDir, dataDir, inferDebugFrameDir, metaDir: path.join(root, 'meta'),
  resolveMetaPath: () => null,
  analysisCachePath: id => path.join(dataDir, 'service-analysis-cache', `${id}.json`),
  inferAnalysisPath: id => path.join(dataDir, 'analysis', `${id}.json`),
  bodyArtifactPath: id => path.join(dataDir, 'body', `${id}.json`),
  readAnalysisCache: () => null,
  shotStore: { listShots: () => [shot, {jobId:'missing-job',media:{filename:'missing.mp4'}}, {jobId:'dup-a',media:{filename:'duplicate.mp4'}}, {jobId:'dup-b',media:{filename:'duplicate.mp4'}}],
    removeShotByFilename: () => { deleted = true; } },
  nasArchive: { enabled: true, deleteJob: async id => { nasCalls.push(id); if (nasFails) throw new Error('synthetic NAS failure'); } },
  app: { delete: (_route, fn) => { handler = fn; } },
};
vm.runInNewContext(cut('function isSafeJobId(', 'function localThumbnailUrl(')
  + cut('function resolveUploadPath(', 'function resolveMetaPath(')
  + cut('async function removeIfPresent(', '// Serve uploaded files statically'), context);
async function remove(name) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
  await handler({ params: { name } }, res);
  return res;
}
try {
  for (const file of [label, unrelated, jobFrame, path.join(uploadDir, '...mp4'), path.join(uploadDir, '..mov'), path.join(uploadDir, 'video.mp4')]) write(file);
  for (const name of ['...mp4', '..mov']) {
    assert.equal((await remove(name)).statusCode, 400);
    assert.ok(fs.existsSync(path.join(uploadDir, name)), 'invalid ID must be rejected before removing the upload');
  }
  assert.deepEqual(nasCalls, [], 'invalid ID must not delete a NAS record');
  write(path.join(uploadDir, 'duplicate.mp4'));
  assert.equal((await remove('duplicate.mp4')).statusCode, 409);
  assert.ok(fs.existsSync(path.join(uploadDir, 'duplicate.mp4')), 'ambiguous associations must preserve the video');
  assert.deepEqual(nasCalls, [], 'ambiguous associations must not delete NAS data');
  assert.equal((await remove('ghost.mp4')).statusCode, 404);
  assert.deepEqual(nasCalls, [], 'a missing unregistered video must not delete an unrelated NAS record');
  assert.equal((await remove('missing.mp4')).statusCode, 200, 'a recorded shot can be cleaned up when its video is already missing');
  assert.deepEqual(nasCalls, ['missing-job']);
  nasCalls.length = 0;
  fs.mkdirSync(path.join(uploadDir, 'directory.mp4'));
  fs.symlinkSync(unrelated, path.join(uploadDir, 'symlink.mp4'));
  for (const name of ['directory.mp4', 'symlink.mp4']) assert.equal((await remove(name)).statusCode, 400);
  assert.deepEqual(nasCalls, [], 'non-files and symlinks must be rejected before NAS deletion');
  nasFails = true;
  assert.equal((await remove('video.mp4')).statusCode, 500);
  assert.ok(fs.existsSync(path.join(uploadDir, 'video.mp4')) && fs.existsSync(jobFrame), 'NAS failure must preserve Pi data');
  nasFails = false;
  nasCalls.length = 0;
  assert.ok(fs.existsSync(unrelated) && fs.existsSync(label), 'other records and labels must remain');
  assert.equal((await remove('video.mp4')).statusCode, 200);
  assert.deepEqual(nasCalls, ['job.1']);
  assert.equal(deleted, true);
  assert.equal(fs.existsSync(path.join(uploadDir, 'video.mp4')), false);
  assert.equal(fs.existsSync(jobFrame), false);
  assert.ok(fs.existsSync(unrelated) && fs.existsSync(label), 'a valid deletion must not touch other records or labels');
  console.log('delete ID isolation and unrelated-data preservation checks passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
