import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('server.js', 'utf8');
const start = source.indexOf('function eventTimeMs(');
const end = source.indexOf('\nasync function requestBodyAnalysis(', start);
assert.ok(start >= 0 && end > start, 'event benchmark code must be present');
const label = (status, kind = 'manual') => ({ status, viewpoint: 'down_the_line', handedness: 'right', events: { impact: { timeMs: 1000, source: kind } } });
const cache = (primary, v2) => ({
  analysis: { events: primary == null ? {} : { impactMs: primary } },
  dtlClubPointsV2: { status: 'succeeded', events: v2 == null ? {} : { impactMs: v2 } },
});
const cases = {
  draft: [label('draft'), cache(900, 1000)],
  analysis: [label('reviewed', 'analysis'), cache(900, 1000)],
  missing: [label('reviewed'), cache(1000, null)],
  unknown: [{ ...label('reviewed'), handedness: 'unknown' }, cache(900, 1000)],
  faceOn: [{ ...label('reviewed'), viewpoint: 'face_on' }, cache(900, 1000)],
  a: [label('reviewed'), cache(1050, 1010)],
  b: [label('reviewed'), cache(1150, 1020)],
};
const context = vm.createContext({
  SWING_EVENT_KEYS: ['impact', 'top'],
  swingTrackingAnnotations: {
    list: async () => Object.keys(cases).map(jobId => ({ jobId })),
    load: async jobId => cases[jobId]?.[0],
  },
  readAnalysisCache: jobId => cases[jobId]?.[1],
});
vm.runInContext(source.slice(start, end), context);
const result = await context.buildDtlClubPointsV2EventBenchmark();
assert.equal(result.annotationJobs, 7);
assert.equal(result.reviewedJobs, 6);
assert.equal(result.inScopeJobs, 4);
assert.equal(result.primaryJobs, 2);
assert.equal(result.v2Jobs, 2);
assert.equal(result.events.impact.primary.samples, 2);
assert.equal(result.events.impact.v2.samples, 2);
assert.equal(result.events.impact.primary.maeMs, 100);
assert.equal(result.events.impact.v2.maeMs, 15);
assert.equal(result.events.impact.v2ImprovesMae, true);
assert.equal(result.events.top.primary.maeMs, null);
assert.equal(result.events.top.v2ImprovesMae, null);
assert.equal(result.referencePolicy, 'reviewed_manual_paired');
assert.equal(result.independentValidation, false);
console.log('event benchmark excludes drafts, unknown scope, analysis labels and unpaired cases');
