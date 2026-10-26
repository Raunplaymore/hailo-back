import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const route = source.slice(source.indexOf("app.post('/api/analyze/:jobId/impact-review'"), source.indexOf("app.get('/api/analyze/:jobId',"));
let handler;
const calls = [];
const shot = { metadata: { analysisInput: { path: '/uploads/known.mp4' } } };
vm.runInNewContext(route, {
  app: { post: (_path, fn) => { handler = fn; } },
  shotStore: { getShotByJobId: (id) => id === 'known' ? shot : null },
  fs: { existsSync: () => true }, inferUrl: p => p,
  inferFetchJson: async (url, options) => { calls.push({url, options}); return {ok: true, json: {status: 'reference_candidate'}}; },
});
async function request(jobId, body) {
  const res = {statusCode: 200, status(s) { this.statusCode = s; return this; }, json(data) { this.data = data; return this; }};
  await handler({params: {jobId}, body}, res); return res;
}
assert.equal((await request('known', {confirmedInput: false})).statusCode, 400);
assert.equal((await request('missing', {confirmedInput: true})).statusCode, 404);
assert.equal((await request('../known', {confirmedInput: true})).statusCode, 400);
assert.equal(calls.length, 0);
assert.equal((await request('known', {confirmedInput: true, inputPath: '/etc/passwd'})).statusCode, 200);
assert.equal(calls[0].options.body.inputPath, '/uploads/known.mp4');
console.log('impact review boundary checks passed');
