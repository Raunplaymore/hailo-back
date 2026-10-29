import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import http from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'hailo-upload-status-'));
const appDir = path.join(root, 'app');
const dataDir = path.join(root, 'data');
let backend, releaseBody;
const bodyGate = new Promise(resolve => { releaseBody = resolve; });
let bodySeen;
const bodyStarted = new Promise(resolve => { bodySeen = resolve; });
let statusRequests = 0;
const fake = http.createServer(async (req, res) => {
  if (req.url === '/v1/body/from-video') {
    bodySeen();
    await bodyGate;
  } else if (req.url?.startsWith('/v1/jobs/')) {
    statusRequests++;
  }
  if (!res.destroyed) {
    res.writeHead(503, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: 'test service unavailable'}));
  }
});
const waitFor = async (fn, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for isolated upload test');
};

try {
  await mkdir(appDir);
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const listener = 'app.listen(PORT, () => {';
  assert.equal(source.split(listener).length, 2);
  await writeFile(path.join(appDir, 'server.js'), source.replace(listener, "app.listen(PORT, '127.0.0.1', () => {"));
  for (const name of ['analysis', 'analyzers', 'store', 'storage', 'node_modules']) {
    await symlink(path.resolve(name), path.join(appDir, name));
  }
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  const fakeBase = `http://127.0.0.1:${fake.address().port}`;
  const portProbe = http.createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  backend = spawn(process.execPath, [path.join(appDir, 'server.js')], {
    env: {...process.env, PORT: String(port), DATA_DIR: dataDir, UPLOAD_DIR: path.join(root, 'uploads'),
      META_DIR: path.join(root, 'meta'), ANALYSIS_CACHE_DIR: path.join(dataDir, 'service-analysis-cache'),
      PERSISTENT_META_DIR: path.join(dataDir, 'meta'), INFER_BASE_URL: fakeBase,
      BODY_ANALYZER_BASE_URL: fakeBase, CAMERA_BASE_URL: fakeBase, NAS_ARCHIVE_URL: '', NAS_ARCHIVE_TOKEN: ''},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', value => { logs += value; });
  backend.stderr.on('data', value => { logs += value; });
  await waitFor(async () => {
    if (backend.exitCode !== null) throw new Error(`isolated backend exited: ${logs}`);
    try { return (await fetch(`${base}/api/files`)).ok; } catch { return false; }
  });
  const form = new FormData();
  form.append('video', new Blob(['fixture'], {type: 'video/mp4'}), 'test.mp4');
  const upload = await fetch(`${base}/api/analyze`, {method: 'POST', body: form});
  assert.equal(upload.status, 200);
  const {jobId} = await upload.json();
  assert.ok(jobId);
  let bodyTimeout;
  try {
    await Promise.race([bodyStarted, new Promise((_, reject) => { bodyTimeout = setTimeout(() => reject(new Error('body request not started')), 10000); })]);
  } finally { clearTimeout(bodyTimeout); }
  for (const suffix of ['', '/result']) {
    const response = await fetch(`${base}/api/analyze/${jobId}${suffix}`);
    const payload = await response.json();
    assert.ok(['queued', 'running'].includes(payload.status), `active upload became ${payload.status}: ${payload.errorCode}`);
    assert.equal(payload.progress?.stage, 'pose_running');
    assert.equal(payload.errorCode, null);
  }
  assert.equal(statusRequests, 0, 'do not query infer for a job that has not yet been submitted');
  await assert.rejects(readFile(path.join(dataDir, 'service-analysis-cache', `${jobId}.json`)), {code: 'ENOENT'});
  releaseBody();
  const failed = await waitFor(async () => {
    const response = await fetch(`${base}/api/analyze/${jobId}`);
    const payload = await response.json();
    return payload.status === 'failed' ? payload : null;
  });
  assert.equal(failed.errorCode, 'INFER_PIPELINE_UNREACHED', 'a real preparation failure must still be reported');
  console.log('active upload remains pending during preparation; real failures still propagate');
} finally {
  releaseBody();
  if (backend && backend.exitCode === null && backend.signalCode === null) {
    const exited = once(backend, 'exit');
    backend.kill('SIGTERM');
    let timeout;
    try { await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, 2000); })]); }
    finally { clearTimeout(timeout); }
    if (backend.exitCode === null && backend.signalCode === null) {
      backend.kill('SIGKILL');
      await exited;
    }
  }
  fake.closeAllConnections();
  if (fake.listening) await new Promise(resolve => fake.close(resolve));
  await rm(root, {recursive: true, force: true});
}
