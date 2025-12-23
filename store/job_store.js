const fs = require('fs');
const path = require('path');

const dataDir =
  process.env.DATA_DIR ||
  (fs.existsSync('/home/ray/data')
    ? '/home/ray/data'
    : path.join(__dirname, '..', 'data'));
const storePath = path.join(dataDir, 'analysis_jobs.json');

fs.mkdirSync(dataDir, { recursive: true });

function loadStore() {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { jobs: [] };
  }
}

function saveStore(store) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
}

function getJob(jobId) {
  if (!jobId) return null;
  const store = loadStore();
  return store.jobs.find((job) => job.jobId === jobId) || null;
}

function upsertJob(job) {
  const store = loadStore();
  const idx = store.jobs.findIndex((item) => item.jobId === job.jobId);
  if (idx >= 0) {
    store.jobs[idx] = job;
  } else {
    store.jobs.push(job);
  }
  saveStore(store);
  return job;
}

function updateJob(jobId, patch) {
  const store = loadStore();
  const idx = store.jobs.findIndex((item) => item.jobId === jobId);
  if (idx === -1) return null;
  const updated = {
    ...store.jobs[idx],
    ...patch,
    result: patch.result !== undefined ? patch.result : store.jobs[idx].result,
  };
  store.jobs[idx] = updated;
  saveStore(store);
  return updated;
}

module.exports = {
  loadStore,
  saveStore,
  getJob,
  upsertJob,
  updateJob,
};
