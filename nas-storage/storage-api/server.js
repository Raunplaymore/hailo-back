const fs = require('fs');
const http = require('http');
const path = require('path');

const archiveRoot = process.env.ARCHIVE_ROOT || '/archive';
const token = process.env.ARCHIVE_TOKEN;
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 4 * 1024 * 1024 * 1024);
const validArtifacts = new Set(['video', 'analysis-cache', 'analysis-result', 'body', 'meta']);

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

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      return send(response, 200, { ok: true });
    }
    if (!isAuthorized(request)) return send(response, 401, { ok: false, error: 'unauthorized' });

    const manifestMatch = request.url?.match(/^\/v1\/jobs\/([a-zA-Z0-9._-]+)\/manifest$/);
    const artifactMatch = request.url?.match(/^\/v1\/jobs\/([a-zA-Z0-9._-]+)\/artifacts\/([a-z-]+)(?:\/([a-zA-Z0-9._-]+))?$/);
    const match = manifestMatch || artifactMatch;
    if (!match) return send(response, 404, { ok: false, error: 'not_found' });
    const jobId = safeSegment(match[1]);
    if (!jobId) return send(response, 400, { ok: false, error: 'invalid_job_id' });

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

server.listen(8080, '0.0.0.0', () => console.log('hailo storage API listening on :8080'));
