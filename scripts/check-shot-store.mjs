import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../store/shotStore.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hailo-shot-store-'));
const originalDataDir = process.env.DATA_DIR;
const load = dir => {
  process.env.DATA_DIR = dir;
  delete require.cache[modulePath];
  return require(modulePath);
};
const seed = { sessions:[{id:'session'}], shots:[{id:'existing',sessionId:'session'}] };
try {
  const dir = path.join(root, 'regular'); fs.mkdirSync(dir);
  const file = path.join(dir, 'shots.json');
  const store = load(dir);
  assert.deepEqual(store.loadStore(), {sessions:[], shots:[]});
  fs.writeFileSync(file, JSON.stringify(seed)); fs.chmodSync(file, 0o640);
  const original = fs.readFileSync(file);
  const rename = fs.renameSync;
  fs.renameSync = (...args) => { if (args[1] === fs.realpathSync(file)) throw Object.assign(new Error('rename failed'), {code:'EIO'}); return rename(...args); };
  try { assert.throws(() => store.addShot({id:'new',sessionId:'session'}), error => error.code === 'SHOT_STORE_UNAVAILABLE' && error.cause?.message === 'rename failed'); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(file), original, 'failed replacement must preserve the old record');
  assert.deepEqual(fs.readdirSync(dir), ['shots.json'], 'failed replacement must clean its temporary file');

  const write = fs.writeFileSync;
  const realFile = fs.realpathSync(file);
  fs.writeFileSync = (name, ...args) => {
    if (typeof name === 'string' && name.startsWith(`${realFile}.`)) {
      write(name, 'partial', {flag:'wx'}); throw Object.assign(new Error('write failed'), {code:'EIO'});
    }
    return write(name, ...args);
  };
  try { assert.throws(() => store.addShot({id:'new',sessionId:'session'}), error => error.code === 'SHOT_STORE_UNAVAILABLE' && error.cause?.message === 'write failed'); }
  finally { fs.writeFileSync = write; }
  assert.deepEqual(fs.readFileSync(file), original, 'interrupted temporary write must preserve the old record');
  assert.deepEqual(fs.readdirSync(dir), ['shots.json']);

  for (const corrupted of ['', '{broken']) {
    fs.writeFileSync(file, corrupted);
    assert.throws(() => store.addShot({id:'new',sessionId:'session'}), error =>
      error.code === 'SHOT_STORE_UNAVAILABLE' && error.cause instanceof SyntaxError && /영상은 이미 저장됐을 수/.test(error.message));
    assert.equal(fs.readFileSync(file, 'utf8'), corrupted, 'invalid JSON must not be replaced by an empty store');
  }
  fs.writeFileSync(file, '{"sessions":[],"shots":null}');
  assert.throws(() => store.addShot({id:'new',sessionId:'session'}), error => error.code === 'SHOT_STORE_UNAVAILABLE');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"sessions":[],"shots":null}', 'invalid structure must remain untouched');
  fs.writeFileSync(file, JSON.stringify(seed));
  store.addShot({id:'new',sessionId:'session'});
  assert.deepEqual(store.listShots().map(s => s.id), ['existing','new']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'existing permissions must be preserved');
  if (process.getuid?.() !== 0) {
    fs.chmodSync(file, 0o400);
    assert.throws(() => store.addShot({id:'forbidden',sessionId:'session'}), error => error.code === 'SHOT_STORE_UNAVAILABLE' && error.cause?.code === 'EACCES');
    assert.deepEqual(store.listShots().map(s => s.id), ['existing','new'], 'read-only records must not be replaced');
  }

  const linkDir = path.join(root, 'link'); fs.mkdirSync(linkDir);
  const target = path.join(root, 'linked-target.json'); fs.writeFileSync(target, JSON.stringify(seed));
  const link = path.join(linkDir, 'shots.json'); fs.symlinkSync(target, link);
  load(linkDir).addShot({id:'new',sessionId:'session'});
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).shots.length, 2);

  const brokenDir = path.join(root, 'dangling'); fs.mkdirSync(brokenDir);
  const dangling = path.join(brokenDir, 'shots.json'); fs.symlinkSync(path.join(root, 'absent.json'), dangling);
  const brokenStore = load(brokenDir);
  assert.throws(() => brokenStore.listShots(), error => error.code === 'SHOT_STORE_UNAVAILABLE' && error.cause?.code === 'ENOENT');
  assert.throws(() => brokenStore.saveStore(seed), error => error.code === 'SHOT_STORE_UNAVAILABLE' && error.cause?.code === 'ENOENT');
  assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);

  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf('function queueUploadedShotAnalysis(');
  const end = server.indexOf('async function analyzeAndStoreUploadedShot(', start);
  assert.ok(start >= 0 && end > start);
  const active = new Set(), errors = [];
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const context = {activeUploadJobs:active, setImmediate, console:{error:(message) => errors.push(message)},
      buildQueuedUploadShot:() => ({jobId:'job'}), analyzeAndStoreUploadedShot:async () => { throw new Error('analysis failed'); },
      markQueuedUploadShotFailed:() => { throw new Error('store unavailable'); }};
    vm.runInNewContext(server.slice(start, end), context);
    context.queueUploadedShotAnalysis({filename:'fixture'}, {});
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(unhandled, false, 'a failure to record a failed job must not crash the process');
    assert.equal(active.size, 0, 'failed upload must leave the active set');
    assert.ok(errors.includes('could not persist failed upload status'));
  } finally { process.off('unhandledRejection', onUnhandled); }
  console.log('shot store preserves prior data on interrupted writes and rejects corrupted input');
} finally {
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
  delete require.cache[modulePath];
  fs.rmSync(root, {recursive:true, force:true});
}
