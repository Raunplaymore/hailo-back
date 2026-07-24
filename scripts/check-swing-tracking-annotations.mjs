import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SCHEMA_VERSION,
  createSwingTrackingAnnotationStore,
  sanitizeAnnotation,
} = require('../store/swingTrackingAnnotations');

const jobId = 'b37c4701-2327-46e7-8011-1cbbc44c9084';
const sanitized = sanitizeAnnotation(jobId, {
  viewpoint: 'down_the_line',
  handedness: 'right',
  status: 'reviewed',
  events: {
    impact: { frame: 35.2, timeMs: 1166.8, source: 'analysis' },
  },
  frames: [
    {
      frame: 35,
      timeMs: 1167,
      clubHead: { x: 0.7, y: 0.4, source: 'manual' },
      clubHandle: { x: 4, y: -1, source: 'model' },
    },
  ],
  notes: 'validated',
});

assert.equal(sanitized.schemaVersion, SCHEMA_VERSION);
assert.equal(sanitized.events.impact.frame, 35);
assert.equal(sanitized.frames[0].clubHead.x, 0.7);
assert.equal(sanitized.frames[0].clubHandle, undefined);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swing-tracking-'));
try {
  const store = createSwingTrackingAnnotationStore({ dataDir: tempDir });
  assert.equal(await store.load(jobId), null);
  const saved = await store.save(jobId, sanitized);
  const loaded = await store.load(jobId);
  assert.equal(loaded.updatedAt, saved.updatedAt);
  assert.equal(loaded.status, 'reviewed');
  assert.equal(loaded.frames.length, 1);
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log('swing tracking annotation check passed');
