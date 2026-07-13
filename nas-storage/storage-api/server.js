const fs = require('fs');
const http = require('http');
const path = require('path');
const { createLibrary } = require('./library');

const archiveRoot = process.env.ARCHIVE_ROOT || '/archive';
const token = process.env.ARCHIVE_TOKEN;
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 4 * 1024 * 1024 * 1024);
const validArtifacts = new Set(['video', 'analysis-cache', 'analysis-result', 'body', 'meta']);
const libraryPassword = process.env.LIBRARY_PASSWORD;
const librarySessionSecret = process.env.LIBRARY_SESSION_SECRET;
const libraryCookieSecure = process.env.LIBRARY_COOKIE_SECURE !== 'false';
const libraryAuthMode = process.env.LIBRARY_AUTH_MODE || 'tailnet';
const port = Number(process.env.PORT || 8080);
const webRoot = process.env.WEB_ROOT || '/web';

if (!token) throw new Error('ARCHIVE_TOKEN is required');

function safeSegment(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]+$/.test(value) ? value : null;
}

function isAuthorized(request) {
  return request.headers.authorization === `Bearer ${token}`;
}

function send(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function sendFile(response, target, contentType) {
  let stat;
  try {
    stat = await fs.promises.stat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return send(response, 404, { ok: false, error: 'not_found' });
    throw error;
  }

  if (!stat.isFile()) return send(response, 404, { ok: false, error: 'not_found' });
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': 'private, no-store',
  });
  fs.createReadStream(target).pipe(response);
}

function artifactContentType(artifact, filename) {
  if (artifact === 'video') return 'video/mp4';
  if (filename.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function webContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.json') return 'application/json';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

async function serveWebAsset(request, response, pathname) {
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolvedRoot = path.resolve(webRoot);
  let target = path.resolve(resolvedRoot, relative);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`) && target !== path.join(resolvedRoot, 'index.html')) return false;
  let stat;
  try {
    stat = await fs.promises.stat(target);
  } catch {
    target = path.join(resolvedRoot, 'index.html');
    try {
      stat = await fs.promises.stat(target);
    } catch {
      return false;
    }
  }
  if (!stat.isFile()) return false;
  response.writeHead(200, {
    'Content-Type': webContentType(target),
    'Content-Length': stat.size,
    'Cache-Control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(target).pipe(response);
  return true;
}

async function writeBody(request, target, limit) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.part`;
  const output = fs.createWriteStream(temporary, { flags: 'w' });
  let bytes = 0;
  await new Promise((resolve, reject) => {
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) request.destroy(new Error('payload too large'));
    });
    request.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
    request.pipe(output);
  });
  await fs.promises.rename(temporary, target);
  return bytes;
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('JSON payload too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function jobDirectory(jobId) {
  return path.join(archiveRoot, 'jobs', jobId);
}

function tombstoneDirectory() {
  return path.join(archiveRoot, 'tombstones');
}

function tombstonePath(jobId) {
  return path.join(tombstoneDirectory(), `${jobId}.json`);
}

async function readTombstone(jobId) {
  try {
    return JSON.parse(await fs.promises.readFile(tombstonePath(jobId), 'utf8'));
  } catch {
    return null;
  }
}

async function deleteArchiveJob(jobId, { source = 'archive' } = {}) {
  const existing = await readTombstone(jobId);
  const deletedAt = existing?.deletedAt || new Date().toISOString();
  const tombstone = { jobId, deletedAt, source };
  await fs.promises.mkdir(tombstoneDirectory(), { recursive: true });
  const target = tombstonePath(jobId);
  await fs.promises.writeFile(`${target}.part`, `${JSON.stringify(tombstone, null, 2)}\n`, 'utf8');
  await fs.promises.rename(`${target}.part`, target);
  await fs.promises.rm(jobDirectory(jobId), { recursive: true, force: true });
  return { deleted: true, deletedAt };
}

async function listDeletions(after) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(tombstoneDirectory(), { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const tombstones = await Promise.all(
    entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => readTombstone(path.basename(entry.name, '.json'))),
  );
  const deletions = tombstones
    .filter((entry) => entry?.jobId && entry?.deletedAt)
    .sort((a, b) => `${a.deletedAt}|${a.jobId}`.localeCompare(`${b.deletedAt}|${b.jobId}`))
    .filter((entry) => `${entry.deletedAt}|${entry.jobId}` > after)
    .slice(0, 100);
  const cursor = deletions.length ? `${deletions.at(-1).deletedAt}|${deletions.at(-1).jobId}` : after;
  return { ok: true, deletions, cursor };
}

const library = createLibrary({
  archiveRoot,
  password: libraryPassword,
  sessionSecret: librarySessionSecret,
  cookieSecure: libraryCookieSecure,
  authMode: libraryAuthMode,
  deleteJob: deleteArchiveJob,
});

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      return send(response, 200, { ok: true });
    }
    if (await library.handle(request, response)) return;

    const url = new URL(request.url || '/', 'http://archive.local');
    if (!url.pathname.startsWith('/v1/')) {
      if (await serveWebAsset(request, response, url.pathname)) return;
      return send(response, 404, { ok: false, error: 'not_found' });
    }
    if (!isAuthorized(request)) return send(response, 401, { ok: false, error: 'unauthorized' });
    if (request.method === 'GET' && url.pathname === '/v1/deletions') {
      return send(response, 200, await listDeletions(String(url.searchParams.get('after') || '')));
    }
    const deletionAckMatch = url.pathname.match(/^\/v1\/deletions\/([a-zA-Z0-9._-]+)\/ack$/);
    if (request.method === 'POST' && deletionAckMatch) {
      const jobId = safeSegment(deletionAckMatch[1]);
      const tombstone = jobId ? await readTombstone(jobId) : null;
      if (!jobId || !tombstone) return send(response, 404, { ok: false, error: 'not_found' });
      const updated = { ...tombstone, piSyncedAt: new Date().toISOString() };
      const target = tombstonePath(jobId);
      await fs.promises.writeFile(`${target}.part`, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      await fs.promises.rename(`${target}.part`, target);
      return send(response, 200, { ok: true, jobId, piSyncedAt: updated.piSyncedAt });
    }

    const jobMatch = url.pathname.match(/^\/v1\/jobs\/([a-zA-Z0-9._-]+)$/);
    const manifestMatch = url.pathname.match(/^\/v1\/jobs\/([a-zA-Z0-9._-]+)\/manifest$/);
    const artifactMatch = url.pathname.match(/^\/v1\/jobs\/([a-zA-Z0-9._-]+)\/artifacts\/([a-z-]+)(?:\/([a-zA-Z0-9._-]+))?$/);
    const match = jobMatch || manifestMatch || artifactMatch;
    if (!match) return send(response, 404, { ok: false, error: 'not_found' });
    const jobId = safeSegment(match[1]);
    if (!jobId) return send(response, 400, { ok: false, error: 'invalid_job_id' });

    if (request.method === 'DELETE' && jobMatch) {
      return send(response, 200, { ok: true, jobId, ...(await deleteArchiveJob(jobId)) });
    }

    if (request.method === 'PUT' && (manifestMatch || artifactMatch) && (await readTombstone(jobId))) {
      return send(response, 410, { ok: false, error: 'job_deleted' });
    }

    if (request.method === 'GET' && manifestMatch) {
      return sendFile(response, path.join(jobDirectory(jobId), 'manifest.json'), 'application/json');
    }

    if (request.method === 'PUT' && manifestMatch) {
      const manifest = await readJson(request);
      await fs.promises.mkdir(jobDirectory(jobId), { recursive: true });
      const manifestPath = path.join(jobDirectory(jobId), 'manifest.json');
      await fs.promises.writeFile(`${manifestPath}.part`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      await fs.promises.rename(`${manifestPath}.part`, manifestPath);
      return send(response, 200, { ok: true, jobId });
    }

    const artifact = artifactMatch?.[2];
    const filename = artifactMatch?.[3] ? safeSegment(artifactMatch[3]) : null;
    if (request.method === 'GET' && validArtifacts.has(artifact)) {
      if (!filename) return send(response, 400, { ok: false, error: 'filename_required' });
      return sendFile(response, path.join(jobDirectory(jobId), artifact, filename), artifactContentType(artifact, filename));
    }

    if (request.method === 'PUT' && validArtifacts.has(artifact)) {
      const uploadFilename = safeSegment(String(request.headers['x-filename'] || ''));
      if (!uploadFilename) return send(response, 400, { ok: false, error: 'invalid_filename' });
      const bytes = await writeBody(request, path.join(jobDirectory(jobId), artifact, uploadFilename), maxUploadBytes);
      return send(response, 200, { ok: true, jobId, artifact, bytes });
    }

    return send(response, 405, { ok: false, error: 'method_not_allowed' });
  } catch (error) {
    console.error(error);
    return send(response, error.message === 'payload too large' ? 413 : 500, { ok: false, error: error.message });
  }
});

server.listen(port, '0.0.0.0', () => console.log(`hailo storage API listening on :${port}`));
