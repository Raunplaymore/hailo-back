const fs = require('fs');
const path = require('path');

const TERMINAL_STATUSES = new Set(['done', 'failed']);
const MAX_ATTEMPTS = 3;

function createNasArchive({ baseUrl, token, timeoutMs = 120_000, logger = console, onStatus, onDeleted } = {}) {
  const origin = String(baseUrl || '').replace(/\/$/, '');
  const enabled = Boolean(origin && token);
  const pending = new Set();

  function reportStatus(payload, status) {
    try {
      onStatus?.({ jobId: payload.jobId, ...status });
      payload.onStatus?.(status);
    } catch (error) {
      logger.warn(`[nas-archive] status update failed for ${payload.jobId}: ${error.message}`);
    }
  }

  async function request(target, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${origin}${target}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        const error = new Error(`NAS archive request failed: ${response.status} ${body}`);
        error.status = response.status;
        if (response.status === 410 && body.includes('job_deleted')) error.code = 'JOB_DELETED';
        throw error;
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function uploadFile(jobId, artifact, filePath) {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return null;
    const extension = path.extname(filePath).toLowerCase() || '.bin';
    const archiveFilename = `${artifact}${extension}`;
    await request(`/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${artifact}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stat.size),
        'X-Filename': archiveFilename,
      },
      body: fs.createReadStream(filePath),
      duplex: 'half',
    });
    return { artifact, filename: archiveFilename, originalFilename: path.basename(filePath), size: stat.size };
  }

  async function uploadJson(jobId, target, payload) {
    await request(`/v1/jobs/${encodeURIComponent(jobId)}/${target}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
}

  async function archive(payload) {
    const { jobId, status, shot, cache } = payload;
    const artifacts = typeof payload.prepareArtifacts === 'function'
      ? await payload.prepareArtifacts(payload.artifacts || [])
      : payload.artifacts || [];
    const uploaded = [];
    for (const { artifact, filePath } of artifacts) {
      if (!filePath || !fs.existsSync(filePath)) continue;
      const result = await uploadFile(jobId, artifact, filePath);
      if (result) uploaded.push(result);
    }
    const archivedShot = shot ? JSON.parse(JSON.stringify(shot)) : null;
    if (archivedShot?.media) delete archivedShot.media.path;
    const archivedAt = new Date().toISOString();
    await uploadJson(jobId, 'manifest', {
      jobId,
      status,
      archivedAt,
      shot: archivedShot,
      analysis: cache?.analysis || null,
      progress: cache?.progress || null,
      artifacts: uploaded,
      ...(payload.manifest && typeof payload.manifest === 'object' ? payload.manifest : {}),
    });
    return { archivedAt, artifacts: uploaded, videoStored: uploaded.some((artifact) => artifact.artifact === 'video') };
  }

  function schedule(payload, attempt = 0) {
    if (!enabled || !payload?.jobId || !TERMINAL_STATUSES.has(payload.status)) return false;
    const key = `${payload.jobId}:${payload.status}`;
    if (pending.has(key)) return false;
    pending.add(key);
    setImmediate(async () => {
      const attemptNumber = attempt + 1;
      try {
        reportStatus(payload, {
          state: 'uploading',
          attempt: attemptNumber,
          retryAt: null,
          error: null,
          updatedAt: new Date().toISOString(),
        });
        const result = await archive(payload);
        reportStatus(payload, {
          state: 'stored',
          attempt: attemptNumber,
          retryAt: null,
          error: null,
          archivedAt: result.archivedAt,
          artifactCount: result.artifacts.length,
          videoStored: result.videoStored,
          updatedAt: new Date().toISOString(),
        });
        logger.info(`[nas-archive] archived ${payload.jobId}`);
      } catch (error) {
        const errorMessage = String(error.message || 'NAS archive failed').slice(0, 240);
        logger.warn(`[nas-archive] ${payload.jobId} attempt ${attemptNumber} failed: ${errorMessage}`);
        if (error.code === 'JOB_DELETED') {
          onDeleted?.(payload.jobId);
          return;
        }
        if (attemptNumber < MAX_ATTEMPTS) {
          const delayMs = 5_000 * attemptNumber;
          reportStatus(payload, {
            state: 'retrying',
            attempt: attemptNumber,
            retryAt: new Date(Date.now() + delayMs).toISOString(),
            error: errorMessage,
            updatedAt: new Date().toISOString(),
          });
          setTimeout(() => schedule(payload, attempt + 1), delayMs);
        } else {
          reportStatus(payload, {
            state: 'failed',
            attempt: attemptNumber,
            retryAt: null,
            error: errorMessage,
            errorCode: error.code || null,
            updatedAt: new Date().toISOString(),
          });
        }
      } finally {
        pending.delete(key);
      }
    });
    return true;
  }

  async function deleteJob(jobId) {
    if (!enabled || !jobId) return { deleted: false, skipped: true };
    const response = await request(`/v1/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    return response.json();
  }

  async function listDeletions(after = '') {
    if (!enabled) return { ok: true, deletions: [], cursor: after, skipped: true };
    const response = await request(`/v1/deletions?after=${encodeURIComponent(after)}`);
    return response.json();
  }

  async function acknowledgeDeletion(jobId) {
    if (!enabled || !jobId) return { ok: true, skipped: true };
    const response = await request(`/v1/deletions/${encodeURIComponent(jobId)}/ack`, { method: 'POST' });
    return response.json();
  }

  return { enabled, schedule, deleteJob, listDeletions, acknowledgeDeletion, isPending: (jobId, status) => pending.has(`${jobId}:${status}`) };
}

module.exports = { createNasArchive };
