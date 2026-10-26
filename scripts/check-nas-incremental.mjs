import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const {createNasArchive} = createRequire(import.meta.url)('../storage/nasArchive.js');
const directory = await mkdtemp(join(tmpdir(), 'nas-incremental-'));
const originalFetch = globalThis.fetch;
const transfers = [], manifests = [];
let block, arrived;
globalThis.fetch = async (url, options) => {
  if (url.includes('/artifacts/')) {
    const chunks = [];
    for await (const chunk of options.body) chunks.push(chunk);
    transfers.push({artifact: url.split('/').pop(), bytes: Buffer.concat(chunks).toString()});
    if (block) {const wait = block; block = null; arrived?.(); await wait;}
  } else if (url.endsWith('/manifest')) manifests.push(JSON.parse(options.body));
  return {ok: true};
};
try {
  const video = join(directory, 'video.mp4'), result = join(directory, 'result.json');
  await writeFile(video, 'original'); await writeFile(result, 'result1');
  let done;
  const statuses = [];
  const archive = createNasArchive({baseUrl: 'http://archive.test', token: 'test', logger: {info() {}, warn() {}}, onStatus: s => {statuses.push(s); if(s.state === 'stored') done?.(s);}});
  const payload = cache => ({jobId: 'job', status: 'done', cache, artifacts: [{artifact: 'video', filePath: video}, {artifact: 'analysis-result', filePath: result}]});
  const run = async p => {
    const completion = new Promise(resolve => {done = resolve;});
    assert.equal(archive.schedule(p), true);
    const status = await completion;
    await new Promise(setImmediate);
    return status;
  };
  const first = await run(payload({analysis: {events: {impact: 2905}}}));
  assert.equal(transfers.length, 2); assert.equal(first.artifacts.length, 2);
  await writeFile(result, 'result2');
  const second = await run(payload({nasArchive: first, analysis: {events: {impact: 2905}}}));
  assert.deepEqual(transfers.map(x => x.artifact), ['video', 'analysis-result', 'analysis-result']);
  assert.equal(second.videoStored, true); assert.equal(manifests[1].artifacts.length, 2);
  assert.equal(manifests[1].artifacts[0].sha256, first.artifacts[0].sha256);
  // Same size, changed content must still upload.
  await writeFile(video, 'changed!');
  const third = await run(payload({nasArchive: second}));
  assert.equal(transfers.at(-1).artifact, 'video');
  assert.notEqual(third.artifacts[0].sha256, second.artifacts[0].sha256);
  // A missing local video must not remove its already archived manifest entry.
  await rm(video);
  const fourth = await run(payload({nasArchive: third}));
  assert.equal(fourth.videoStored, true); assert.equal(manifests.at(-1).artifacts.length, 2);
  // A completed sidecar arriving during an archive must get a subsequent manifest.
  await writeFile(result, 'result3');
  let release;
  const started = new Promise(resolve => {arrived = resolve;});
  block = new Promise(resolve => {release = resolve;});
  const completions = [];
  let finish;
  const finished = new Promise(resolve => {finish = resolve;});
  done = s => {completions.push(s); if (completions.length === 2) finish();};
  archive.schedule(payload({nasArchive: fourth, analysis: {version: 1}}));
  await started;
  assert.equal(archive.schedule(payload({nasArchive: fourth, analysis: {version: 2}})), false);
  release(); await finished;
  assert.equal(manifests.at(-1).analysis.version, 2);
  assert.equal(transfers.filter(x => x.bytes === 'result3').length, 1);
  console.log('NAS incremental: unchanged skip, content changes, missing-local preservation, in-flight coalescing passed');
} finally {globalThis.fetch = originalFetch; await rm(directory, {recursive: true, force: true});}
