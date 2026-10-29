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
const nasCalls = [];
const shot = { jobId: 'job.1', media: { filename: 'video.mp4' } };
const context = {
  fs, path, uploadDir, dataDir, inferDebugFrameDir, metaDir: path.join(root, 'meta'),
  resolveMetaPath: () => null,
  analysisCachePath: id => path.join(dataDir, 'service-analysis-cache', `${id}.json`),
  inferAnalysisPath: id => path.join(dataDir, 'analysis', `${id}.json`),
  bodyArtifactPath: id => path.join(dataDir, 'body', `${id}.json`),
  readAnalysisCache: () => null,
  shotStore: { getShotByMediaName: name => name === 'video.mp4' ? shot : null,
    removeShotByFilename: () => { deleted = true; } },
  nasArchive: { enabled: true, deleteJob: async id => { nasCalls.push(id); } },
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
