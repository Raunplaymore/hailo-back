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
  validateAnnotationIdentity,
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
      clubHandleVisibility: 'occluded',
    },
  ],
  notes: 'validated',
});

assert.equal(sanitized.schemaVersion, SCHEMA_VERSION);
assert.equal(sanitized.events.impact.frame, 35);
assert.equal(sanitized.frames[0].clubHead.x, 0.7);
assert.equal(sanitized.frames[0].clubHandle, undefined);
assert.equal(sanitized.frames[0].clubHeadVisibility, 'visible');
assert.equal(sanitized.frames[0].clubHandleVisibility, 'occluded');
const uncertain = sanitizeAnnotation(jobId, {
  events: { impact: { frame: 2, timeMs: 34 } },
  frames: [{ frame: 2, timeMs: 34, clubHead: { x: .5, y: .5 } }],
});
assert.equal(uncertain.events.impact.source, 'unknown', 'missing event provenance is not manual');
assert.equal(uncertain.frames[0].clubHead.source, 'unknown', 'missing point provenance is not manual');
assert.equal(sanitizeAnnotation(jobId, {}).viewpoint, 'unknown');
assert.equal(sanitizeAnnotation(jobId, {}).handedness, 'unknown');
assert.equal(sanitizeAnnotation(jobId, { handedness: 'unknown' }).handedness, 'unknown');
for (const invalid of [null, '', ' ', false, []]) {
  const bad = sanitizeAnnotation(jobId, { events: { impact: { frame: invalid, timeMs: 20, source: 'manual' } },
    frames: [{ frame: 1, timeMs: 20, clubHead: { x: invalid, y: .5, source: 'manual' } }] });
  assert.equal(bad.events.impact, null, 'missing frame must not become zero');
  assert.equal(bad.frames.length, 0, 'missing coordinate must not become zero');
}
assert.equal(validateAnnotationIdentity(jobId, sanitized), null);
assert.equal(
  validateAnnotationIdentity(jobId, { ...sanitized, jobId: 'different-job' }).code,
  'ANNOTATION_JOB_MISMATCH'
);
assert.equal(
  validateAnnotationIdentity(jobId, {
    ...sanitized,
    source: { ...sanitized.source, metaPath: '/tmp/different-job.meta.json' },
  }).code,
  'ANNOTATION_SOURCE_MISMATCH'
);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swing-tracking-'));
try {
  const store = createSwingTrackingAnnotationStore({ dataDir: tempDir });
  assert.equal(await store.load(jobId), null);
  const saved = await store.save(jobId, sanitized);
  const loaded = await store.load(jobId);
  assert.equal(loaded.updatedAt, saved.updatedAt);
  assert.equal(loaded.status, 'reviewed');
  assert.equal(loaded.frames.length, 1);
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].jobId, jobId);
  assert.equal(listed[0].labeledFrames, 1);
  assert.equal(listed[0].events, 1);
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log('swing tracking annotation check passed');
