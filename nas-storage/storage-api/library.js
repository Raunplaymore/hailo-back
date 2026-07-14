const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(payload));
}

function safeSegment(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]+$/.test(value) ? value : null;
}

function parseCookies(value) {
  return Object.fromEntries(
    String(value || '')
      .split(';')
      .map((entry) => entry.trim().split('='))
      .filter(([key, cookieValue]) => key && cookieValue)
      .map(([key, cookieValue]) => [key, decodeURIComponent(cookieValue)]),
  );
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createSession(secret) {
  const payload = toBase64Url(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, nonce: crypto.randomUUID() }));
  return `${payload}.${sign(payload, secret)}`;
}

function readSession(request, secret) {
  const value = parseCookies(request.headers.cookie).hailo_library_session;
  if (!value || typeof value !== 'string') return null;
  const [payload, signature] = value.split('.');
  const expectedSignature = payload ? sign(payload, secret) : '';
  if (!payload || !signature || signature.length !== expectedSignature.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(parsed.exp) > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16 * 1024) throw new Error('payload_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function cookie(value, secure) {
  return `hailo_library_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
}

function expiredCookie(secure) {
  return `hailo_library_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

function sanitizeShot(shot) {
  if (!shot || typeof shot !== 'object') return null;
  const copy = JSON.parse(JSON.stringify(shot));
  if (copy.media) delete copy.media.path;
  return copy;
}

async function readManifest(jobDirectory) {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(jobDirectory, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

function artifactEntry(manifest, artifact) {
  const entry = Array.isArray(manifest?.artifacts) ? manifest.artifacts.find((item) => item?.artifact === artifact) : null;
  return entry?.filename && safeSegment(entry.filename) ? entry : null;
}

function jobSummary(manifest) {
  const video = artifactEntry(manifest, 'video');
  const thumbnail = artifactEntry(manifest, 'thumbnail');
  return {
    jobId: manifest.jobId,
    status: manifest.status,
    archivedAt: manifest.archivedAt,
    shot: sanitizeShot(manifest.shot),
    videoStored: Boolean(video),
    thumbnailUrl: thumbnail ? `/api/library/jobs/${encodeURIComponent(manifest.jobId)}/thumbnail` : null,
    analysis: manifest.analysis
      ? { status: manifest.analysis.status, summary: manifest.analysis.summary, confidence: manifest.analysis.confidence }
      : null,
  };
}

function archiveKey(manifest) {
  return `${String(manifest?.archivedAt || '')}\u0000${String(manifest?.jobId || '')}`;
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed?.archivedAt !== 'string' || !safeSegment(parsed?.jobId)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function encodeCursor(manifest) {
  return Buffer.from(JSON.stringify({ archivedAt: manifest.archivedAt, jobId: manifest.jobId })).toString('base64url');
}

function createLibrary({ archiveRoot, password, sessionSecret, cookieSecure = true, authMode = 'tailnet', deleteJob }) {
  const usesPasswordAuth = authMode === 'password';
  const enabled = !usesPasswordAuth || Boolean(password && sessionSecret);
  const jobsRoot = path.join(archiveRoot, 'jobs');

  function authenticated(request) {
    return enabled && (!usesPasswordAuth || Boolean(readSession(request, sessionSecret)));
  }

  async function listJobs(url) {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50));
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const since = Date.parse(String(url.searchParams.get('since') || ''));
    const until = Date.parse(String(url.searchParams.get('until') || ''));
    let entries = [];
    try {
      entries = await fs.promises.readdir(jobsRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const manifests = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => readManifest(path.join(jobsRoot, entry.name))),
    );
    const matchingJobs = manifests
      .filter((manifest) => manifest?.jobId && safeSegment(manifest.jobId))
      .filter((manifest) => !Number.isFinite(since) || Date.parse(String(manifest.archivedAt || '')) >= since)
      .filter((manifest) => !Number.isFinite(until) || Date.parse(String(manifest.archivedAt || '')) <= until)
      .sort((a, b) => archiveKey(b).localeCompare(archiveKey(a)));
    const remainingJobs = cursor
      ? matchingJobs.filter((manifest) => archiveKey(manifest) < archiveKey(cursor))
      : matchingJobs;
    const page = remainingJobs.slice(0, limit);
    return {
      ok: true,
      jobs: page.map(jobSummary),
      total: matchingJobs.length,
      nextCursor: remainingJobs.length > page.length ? encodeCursor(page.at(-1)) : null,
    };
  }

  async function streamVideo(response, jobId, manifest, request) {
    const video = artifactEntry(manifest, 'video');
    if (!video) return sendJson(response, 404, { ok: false, error: 'video_unavailable' });
    const target = path.join(jobsRoot, jobId, 'video', video.filename);
    let stat;
    try {
      stat = await fs.promises.stat(target);
    } catch {
      return sendJson(response, 404, { ok: false, error: 'video_unavailable' });
    }
    const range = request.headers.range;
    if (!range) {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' });
      return fs.createReadStream(target).pipe(response);
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return sendJson(response, 416, { ok: false, error: 'invalid_range' });
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return response.end();
    }
    response.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
    });
    return fs.createReadStream(target, { start, end }).pipe(response);
  }

  async function streamThumbnail(response, jobId, manifest) {
    const thumbnail = artifactEntry(manifest, 'thumbnail');
    if (!thumbnail) return sendJson(response, 404, { ok: false, error: 'thumbnail_unavailable' });
    const target = path.join(jobsRoot, jobId, 'thumbnail', thumbnail.filename);
    let stat;
    try {
      stat = await fs.promises.stat(target);
    } catch {
      return sendJson(response, 404, { ok: false, error: 'thumbnail_unavailable' });
    }
    response.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': stat.size,
      'Cache-Control': 'private, max-age=86400',
    });
    return fs.createReadStream(target).pipe(response);
  }

  async function handle(request, response) {
    const url = new URL(request.url || '/', 'http://library.local');
    if (!url.pathname.startsWith('/api/')) return false;
    if (!enabled) {
      sendJson(response, 503, { ok: false, error: 'library_not_configured' });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/login' && usesPasswordAuth) {
      const body = await readJson(request);
      const supplied = Buffer.from(String(body.password || ''));
      const expected = Buffer.from(password);
      const valid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
      if (!valid) {
        sendJson(response, 401, { ok: false, error: 'invalid_credentials' });
        return true;
      }
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': cookie(createSession(sessionSecret), cookieSecure) });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/logout' && usesPasswordAuth) {
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': expiredCookie(cookieSecure) });
      return true;
    }
    if (!authenticated(request)) {
      sendJson(response, 401, { ok: false, error: 'unauthorized' });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      sendJson(response, 200, { ok: true, authenticated: true });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/library/jobs') {
      sendJson(response, 200, await listJobs(url));
      return true;
    }
    const match = url.pathname.match(/^\/api\/library\/jobs\/([a-zA-Z0-9._-]+)(?:\/(video|thumbnail))?$/);
    if (!match) {
      sendJson(response, 404, { ok: false, error: 'not_found' });
      return true;
    }
    const jobId = safeSegment(match[1]);
    const manifest = jobId ? await readManifest(path.join(jobsRoot, jobId)) : null;
    if (!jobId || !manifest) {
      sendJson(response, 404, { ok: false, error: 'not_found' });
      return true;
    }
    if (request.method === 'GET' && match[2] === 'video') {
      await streamVideo(response, jobId, manifest, request);
      return true;
    }
    if (request.method === 'GET' && match[2] === 'thumbnail') {
      await streamThumbnail(response, jobId, manifest);
      return true;
    }
    if (request.method === 'GET' && !match[2]) {
      sendJson(response, 200, { ok: true, job: { ...jobSummary(manifest), analysis: manifest.analysis || null, progress: manifest.progress || null, artifacts: manifest.artifacts || [] } });
      return true;
    }
    if (request.method === 'DELETE' && !match[2]) {
      const result = await deleteJob(jobId, { source: 'library' });
      sendJson(response, 200, { ok: true, jobId, ...result });
      return true;
    }
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  return { enabled, handle };
}

module.exports = { createLibrary };
