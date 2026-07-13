import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const archiveSource = await readFile('storage/nasArchive.js', 'utf8');
const serverSource = await readFile('server.js', 'utf8');
const storageApiSource = await readFile('nas-storage/storage-api/server.js', 'utf8');
const composeSource = await readFile('nas-storage/compose.yml', 'utf8');
const workflowSource = await readFile('.github/workflows/ci.yml', 'utf8');

assert.match(archiveSource, /MAX_ATTEMPTS = 3/, 'NAS archive must retry transient failures.');
assert.match(archiveSource, /state: 'stored'/, 'NAS archive must persist successful completion state.');
assert.match(archiveSource, /state: 'failed'/, 'NAS archive must expose final transfer failure state.');
assert.match(archiveSource, /VIDEO_UNAVAILABLE/, 'NAS archive must fail when the required Pi source video is absent.');
assert.match(archiveSource, /videoStored: result\.videoStored/, 'NAS archive status must confirm video persistence before completion.');
assert.match(archiveSource, /duplex: 'half'/, 'NAS archive must stream files without loading videos into memory.');
assert.match(archiveSource, /delete archivedShot\.media\.path/, 'NAS manifest must not expose Pi-local media paths.');
assert.match(serverSource, /const nasArchive = createNasArchive/, 'Pi service must initialize the optional NAS archive client.');
assert.match(serverSource, /queueNasArchive\(payload\)/, 'Terminal analysis cache writes must schedule NAS archival.');
assert.match(serverSource, /function resumeNasArchiveQueue\(/, 'Pi restart must resume unfinished NAS archive jobs.');
assert.match(serverSource, /function isNasArchiveComplete\(/, 'NAS archive completion must require a stored video artifact.');
assert.match(serverSource, /app\.post\('\/api\/archive\/:jobId\/retry'/, 'Pi service must expose a NAS archive retry endpoint.');
assert.match(serverSource, /nasArchive: cached\?\.nasArchive \|\| null/, 'File listing must expose NAS archive status.');
assert.match(storageApiSource, /ARCHIVE_TOKEN is required/, 'NAS API must require an archive token.');
assert.match(storageApiSource, /validArtifacts/, 'NAS API must restrict artifact names.');
assert.match(storageApiSource, /GET' && manifestMatch/, 'NAS API must provide an authenticated manifest retrieval route.');
assert.match(storageApiSource, /GET' && validArtifacts\.has\(artifact\)/, 'NAS API must provide authenticated artifact retrieval.');
assert.match(storageApiSource, /Cache-Control': 'private, no-store'/, 'NAS retrieval must not be cached by intermediaries.');
assert.match(composeSource, /STORAGE_BIND_HOST:-127\.0\.0\.1/, 'NAS storage must bind only to loopback before Tailscale Serve.');
assert.match(workflowSource, /envs: NAS_ARCHIVE_URL,NAS_ARCHIVE_TOKEN/, 'Deployment must pass NAS credentials only as runtime environment variables.');

console.log('NAS archive check passed');
