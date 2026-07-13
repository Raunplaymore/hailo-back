import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const archiveSource = await readFile('storage/nasArchive.js', 'utf8');
const serverSource = await readFile('server.js', 'utf8');
const storageApiSource = await readFile('nas-storage/storage-api/server.js', 'utf8');
const workflowSource = await readFile('.github/workflows/ci.yml', 'utf8');

assert.match(archiveSource, /MAX_ATTEMPTS = 3/, 'NAS archive must retry transient failures.');
assert.match(archiveSource, /duplex: 'half'/, 'NAS archive must stream files without loading videos into memory.');
assert.match(archiveSource, /delete archivedShot\.media\.path/, 'NAS manifest must not expose Pi-local media paths.');
assert.match(serverSource, /const nasArchive = createNasArchive/, 'Pi service must initialize the optional NAS archive client.');
assert.match(serverSource, /queueNasArchive\(payload\)/, 'Terminal analysis cache writes must schedule NAS archival.');
assert.match(storageApiSource, /ARCHIVE_TOKEN is required/, 'NAS API must require an archive token.');
assert.match(storageApiSource, /validArtifacts/, 'NAS API must restrict artifact names.');
assert.match(workflowSource, /envs: NAS_ARCHIVE_URL,NAS_ARCHIVE_TOKEN/, 'Deployment must pass NAS credentials only as runtime environment variables.');

console.log('NAS archive check passed');
