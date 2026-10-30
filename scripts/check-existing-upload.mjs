import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'hailo-existing-upload-'));
const appDir = path.join(root, 'app'), dataDir = path.join(root, 'data'), uploadDir = path.join(root, 'uploads');
const gates = [], bodyCalls = [];
for (let i = 0; i < 2; i++) { let release, seen; gates.push({ wait: new Promise(r => { release = r; }), started: new Promise(r => { seen = r; }), release, seen }); }
let backend;
const fake = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url === '/v1/body/from-video') {
    const index = bodyCalls.length; bodyCalls.push(JSON.parse(raw));
    gates[index]?.seen(); if (gates[index]) await gates[index].wait;
  }
  if (!res.destroyed) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"fixture unavailable"}'); }
});
const waitFor = async (fn, timeoutMs = 20000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('existing-upload test timed out');
};
try {
  await mkdir(appDir); await mkdir(dataDir); await mkdir(uploadDir);
  await writeFile(path.join(uploadDir, 'orphan.mp4'), 'synthetic video');
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const listener = 'app.listen(PORT, () => {'; assert.equal(source.split(listener).length, 2);
  await writeFile(path.join(appDir, 'server.js'), source.replace(listener, "app.listen(PORT, '127.0.0.1', () => {"));
  for (const name of ['analysis', 'analyzers', 'store', 'storage', 'node_modules']) await symlink(path.resolve(name), path.join(appDir, name));
  fake.listen(0, '127.0.0.1'); await once(fake, 'listening');
  const fakeBase = `http://127.0.0.1:${fake.address().port}`;
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  backend = spawn(process.execPath, [path.join(appDir, 'server.js')], { env: { ...process.env, PORT: String(port),
    DATA_DIR: dataDir, UPLOAD_DIR: uploadDir, META_DIR: path.join(root, 'meta'),
    ANALYSIS_CACHE_DIR: path.join(dataDir, 'cache'), PERSISTENT_META_DIR: path.join(dataDir, 'meta'),
    INFER_BASE_URL: fakeBase, BODY_ANALYZER_BASE_URL: fakeBase, CAMERA_BASE_URL: fakeBase, NAS_ARCHIVE_URL: '', NAS_ARCHIVE_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout.on('data', value => { logs += value; }); backend.stderr.on('data', value => { logs += value; });
  await waitFor(async () => { if (backend.exitCode !== null) throw new Error(`backend exited: ${logs}`); try { return (await fetch(`${base}/api/files`)).ok; } catch { return false; } });
  const post = (filename, options = {}) => fetch(`${base}/api/analyze/existing-upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename, options }) });
  for (const bad of ['../outside.mp4', 'folder/video.mp4', '\\outside.mp4', 'bad\0.mp4', 'x'.repeat(256) + '.mp4', 'bad.txt']) assert.equal((await post(bad)).status, 400);
  for (const bad of [{viewpoint:'diagonal'}, {handedness:'sideways'}, {force:'true'}, {club:{}}, []]) {
    assert.equal((await post('orphan.mp4', bad)).status, 400);
  }
  assert.equal((await post('missing.mp4')).status, 404);
  await writeFile(path.join(root, 'outside.mp4'), 'outside'); await symlink(path.join(root, 'outside.mp4'), path.join(uploadDir, 'link.mp4'));
  assert.equal((await post('link.mp4')).status, 400); await rm(path.join(uploadDir, 'link.mp4'));
  await writeFile(path.join(uploadDir, 'empty.mp4'), ''); assert.equal((await post('empty.mp4')).status, 400); await rm(path.join(uploadDir, 'empty.mp4'));
  assert.equal(await readFile(path.join(root, 'outside.mp4'), 'utf8'), 'outside');
  const storePath = path.join(dataDir, 'shots.json');
  await writeFile(path.join(uploadDir, 'camera.mp4'), 'camera video');
  const cameraShot = {id:'camera',jobId:'camera-job',sourceType:'camera',status:'failed',
    media:{filename:'camera.mp4',path:path.join(uploadDir,'camera.mp4')},metadata:{metaPath:'/tmp/camera.meta.json'}};
  const cameraStore = JSON.stringify({sessions:[],shots:[cameraShot]});
  await writeFile(storePath, cameraStore);
  const listing = await (await fetch(`${base}/api/files/detail?summary=true`)).json();
  const camera = listing.files.find(file => file.filename === 'camera.mp4');
  assert.equal(camera.sourceType, 'camera'); assert.equal(camera.metaPath, '/tmp/camera.meta.json');
  assert.equal((await post('camera.mp4')).status, 409, 'camera recordings must not enter the upload pipeline');
  assert.equal(await readFile(storePath, 'utf8'), cameraStore);
  await writeFile(path.join(uploadDir, 'duplicate.mp4'), 'duplicate video');
  const duplicateStore = JSON.stringify({sessions:[],shots:[
    {id:'a',jobId:'a',sourceType:'upload',media:{filename:'duplicate.mp4'}},
    {id:'b',jobId:'b',sourceType:'upload',media:{filename:'duplicate.mp4'}}]});
  await writeFile(storePath, duplicateStore);
  assert.equal((await post('duplicate.mp4')).status, 409, 'ambiguous record associations must not be replaced');
  assert.equal(await readFile(storePath, 'utf8'), duplicateStore);
  await rm(path.join(uploadDir, 'camera.mp4')); await rm(path.join(uploadDir, 'duplicate.mp4'));
  await writeFile(storePath, '{broken');
  const corruptResponse = await post('orphan.mp4'); assert.equal(corruptResponse.status, 500);
  const corruptError = await corruptResponse.json();
  assert.equal(corruptError.errorCode, 'SHOT_STORE_UNAVAILABLE'); assert.match(corruptError.message, /영상은 이미 저장됐을 수/);
  assert.equal(await readFile(storePath, 'utf8'), '{broken');
  assert.equal(await readFile(path.join(uploadDir, 'orphan.mp4'), 'utf8'), 'synthetic video');
  await writeFile(storePath, JSON.stringify({sessions: [], shots: []}));

  const first = await (await post('orphan.mp4', { viewpoint: 'down_the_line', handedness: 'right' })).json();
  assert.equal(first.status, 'queued'); assert.ok(first.jobId);
  await gates[0].started;
  const duplicate = await (await post('orphan.mp4')).json();
  assert.equal(duplicate.jobId, first.jobId); assert.equal(bodyCalls.length, 1);
  const beforeConflict = await readFile(storePath, 'utf8');
  const conflict = await fetch(`${base}/api/analyze/from-file`, {method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({filename:'orphan.mp4',jobId:'different-job'})});
  assert.equal(conflict.status, 409, 'another route must not replace the active video association');
  assert.equal(await readFile(storePath, 'utf8'), beforeConflict);
  assert.deepEqual(await readdir(uploadDir), ['orphan.mp4']);
  assert.equal(bodyCalls[0].inputPath, path.join(uploadDir, 'orphan.mp4'));
  const active = await (await fetch(`${base}/api/analyze/${first.jobId}`)).json();
  assert.ok(['queued', 'running'].includes(active.status)); assert.equal(active.errorCode, null);
  gates[0].release();
  await waitFor(async () => (await (await fetch(`${base}/api/analyze/${first.jobId}`)).json()).status === 'failed');
  const oldData = JSON.parse(await readFile(storePath, 'utf8'));
  const oldShot = oldData.shots.find(shot => shot.jobId === first.jobId); assert.ok(oldShot);
  oldShot.media.originalName = 'original.mp4';
  Object.assign(oldShot.metadata, {h_fov:58, v_fov:42, fps:60, customNote:'keep',
    metaPath:'/old/meta',bodyPath:'/old/body',analysisInput:{path:'/old/video'}});
  await writeFile(storePath, JSON.stringify(oldData));
  const oldStore = await readFile(storePath, 'utf8');
  const oldCachePath = path.join(dataDir, 'cache', `${first.jobId}.json`), oldCache = await readFile(oldCachePath, 'utf8');
  const labelPath = path.join(dataDir, 'annotations', 'swing-tracking', `${first.jobId}.json`);
  await writeFile(labelPath, 'independent labels');
  const labeledRetry = await post('orphan.mp4', { force: true });
  assert.equal(labeledRetry.status, 409); assert.match((await labeledRetry.json()).message, /기존 라벨/);
  assert.equal(await readFile(storePath, 'utf8'), oldStore);
  assert.equal(await readFile(oldCachePath, 'utf8'), oldCache);
  assert.equal(await readFile(labelPath, 'utf8'), 'independent labels');
  assert.equal(await readFile(path.join(uploadDir, 'orphan.mp4'), 'utf8'), 'synthetic video');
  await rm(labelPath);
  const backupDir = path.join(dataDir, 'shot-retry-snapshots');
  await writeFile(backupDir, 'not a directory');
  assert.equal((await post('orphan.mp4')).status, 500);
  assert.equal(await readFile(storePath, 'utf8'), oldStore, 'failed snapshot must not change prior records');
  await rm(backupDir);
  const retry = await (await post('orphan.mp4', { force: true })).json();
  assert.equal(retry.status, 'queued'); assert.notEqual(retry.jobId, first.jobId);
  await gates[1].started;
  assert.equal(bodyCalls[1].force, true);
  const retriedShot = JSON.parse(await readFile(storePath, 'utf8')).shots.find(shot => shot.jobId === retry.jobId);
  assert.equal(retriedShot.media.originalName, 'original.mp4');
  assert.equal(retriedShot.metadata.h_fov, 58); assert.equal(retriedShot.metadata.v_fov, 42);
  assert.equal(retriedShot.metadata.fps, 60); assert.equal(retriedShot.metadata.customNote, 'keep');
  assert.notEqual(retriedShot.metadata.metaPath, '/old/meta'); assert.notEqual(retriedShot.metadata.bodyPath, '/old/body');
  assert.notEqual(retriedShot.metadata.analysisInput?.path, '/old/video');
  const retryStatus = await (await fetch(`${base}/api/analyze/${retry.jobId}`)).json();
  assert.ok(['queued', 'running'].includes(retryStatus.status)); assert.equal(retryStatus.errorCode, null);
  assert.equal(await readFile(oldCachePath, 'utf8'), oldCache, 'retry must not replace the prior analysis cache');
  const backups = await readdir(backupDir); assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(backupDir, backups[0]), 'utf8')), oldShot);
  gates[1].release();
  await waitFor(async () => (await (await fetch(`${base}/api/analyze/${retry.jobId}`)).json()).status === 'failed');
  assert.equal(await readFile(path.join(uploadDir, 'orphan.mp4'), 'utf8'), 'synthetic video');
  assert.deepEqual(await readdir(uploadDir), ['orphan.mp4']);

  await writeFile(path.join(uploadDir, 'completed.mp4'), 'complete');
  await writeFile(path.join(dataDir, 'cache', 'completed.json'), JSON.stringify({ status: 'done', analysis: { summary: 'prior result' } }));
  assert.equal((await post('completed.mp4')).status, 409, 'existing completed results must not be replaced');
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'cache', 'completed.json'), 'utf8')).analysis, { summary: 'prior result' });
  await writeFile(path.join(uploadDir, 'running.mp4'), 'running');
  await writeFile(path.join(dataDir, 'cache', 'running.json'), JSON.stringify({ status: 'running' }));
  assert.equal((await post('running.mp4')).status, 409, 'unknown running jobs must not be replaced');
  console.log('existing uploads reuse the original file, deduplicate active requests and preserve prior results');
} finally {
  for (const gate of gates) gate.release();
  if (backend && backend.exitCode === null && backend.signalCode === null) { const exited = once(backend, 'exit'); backend.kill('SIGTERM'); await exited; }
  fake.closeAllConnections(); if (fake.listening) await new Promise(resolve => fake.close(resolve));
  await rm(root, { recursive: true, force: true });
}
