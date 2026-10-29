import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import cacheModule from "../store/impactReviewCache.js";

const jobId = "957e5457-4d13-46bf-88c6-65c467af8487";
const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
assert.match(source, /const imageName = `frame_\$\{String\(safeFrameIndex\)/, "Cached image names must use the source frame number used by labels and dataset exports.");
assert.match(source, /legacyFrameNumbersChanged:/, "Old labels must be flagged when inferred frame numbers change.");
const match = source.match(/function frameTimeMs\([\s\S]*?\n}\n\nfunction selectDebugFrames/);
assert(match, "frameTimeMs implementation not found");

const context = {};
vm.runInNewContext(`${match[0].replace(/\n\nfunction selectDebugFrames$/, "")}; this.frameTimeMs = frameTimeMs;`, context);

const fps = 29.97002997002997;
for (const [frame, expectedTimeMs] of [[94, 3136], [34, 1132], [65, 2164], [73, 2431], [77, 2564]]) {
  const actual = context.frameTimeMs({ frame, timeMs: Math.round((frame * 954) / 94) }, frame, fps);
  assert.ok(Math.abs(actual - expectedTimeMs) <= 80, `${jobId}: frame ${frame} must use the video frame clock, got ${actual}`);
}

const mapFrames = context.mapDebugSourceFrames;
const frames = [0, 33, 50].map((sourceTimeMs) => ({ sourceTimeMs }));
assert.deepEqual(Array.from(mapFrames(frames, [0, 16.667, 33.333, 50])), [0, 2, 3], "A dropped inference frame must not shift subsequent image indices.");
assert.equal(mapFrames([{ sourceTimeMs: 0 }, { sourceTimeMs: 40 }], [0, 16.667, 33.333]), null, "Unmatched timestamps must not claim a verified mapping.");
assert.equal(mapFrames([{ sourceTimeMs: 1 }], [0, 2]), null, "Equidistant source frames are ambiguous.");
assert.equal(mapFrames([{ sourceTimeMs: 0 }, { sourceTimeMs: 0 }], [0, 16]), null, "Duplicate inference timestamps are invalid.");
assert.equal(mapFrames([{ sourceTimeMs: 0 }, {}], [0, 16]), null, "Missing inference timestamps are not verified.");
assert.equal(mapFrames([{ sourceTimeMs: 0 }], [0, 0]), null, "Duplicate video timestamps are invalid.");

const markGaps = context.markSourceFrameGaps;
assert.equal(typeof markGaps, 'function', 'source-frame coverage must be checked before marking a trail');
const videoTimes = [0, 16.667, 33.333, 50, 66.667, 83.333];
const meta = [0, 16.667, 50, 66.667].map((sourceTimeMs, frame) => ({ sourceTimeMs, frame }));
const seen = { x: .2, y: .4, confidence: .9 };
const overlay = { clubTimeSource: 'video_pts', clubFrames: meta.map(({ sourceTimeMs, frame }) => ({
  timeMs: Math.round(sourceTimeMs), frame, head: seen, handle: seen,
})) };
const snapshot = JSON.stringify({ meta, overlay, videoTimes });
const marked = markGaps(overlay, meta, videoTimes);
assert.equal(marked.verified, true);
assert.equal(marked.missingFrames, 2);
assert.equal(marked.overlay.clubFrames[1].timeMs, 16.667, 'display timestamps must use the actual video frame clock');
assert.equal(marked.overlay.clubFrames[1].headValidUntilMs, 33.333);
assert.equal(marked.overlay.clubFrames[1].handleValidUntilMs, 33.333);
assert.equal(marked.overlay.clubFrames[2].headBreakBefore, true);
assert.equal(marked.overlay.clubFrames[2].handleBreakBefore, true);
assert.equal(marked.overlay.clubFrames.at(-1).headValidUntilMs, 83.333);
assert.equal(JSON.stringify({ meta, overlay, videoTimes }), snapshot, 'inputs and original cached observations must not be modified');

const implicitMeta = meta.map(({ sourceTimeMs }, i) => i % 2 ? { sourceTimeMs, frame: null } : { sourceTimeMs });
const implicit = markGaps(overlay, implicitMeta, videoTimes);
assert.equal(implicit.verified, true, 'camera metadata may omit frame numbers');
assert.equal(implicit.missingFrames, 2);
assert.equal(implicit.overlay.clubFrames[1].headValidUntilMs, 33.333);
assert.equal(implicit.overlay.clubFrames[2].timeMs, 50, 'metadata row numbers must not replace the source video clock');
assert.equal(implicit.overlay.clubFrames[2].headBreakBefore, true);

const sampled = { ...overlay, clubFrames: [overlay.clubFrames[0], ...overlay.clubFrames.slice(2)] };
const markedSampled = markGaps(sampled, meta, videoTimes);
assert.equal(markedSampled.overlay.clubFrames[0].headValidUntilMs, 33.333, 'sampling must not hide a missing frame');
assert.equal(markedSampled.overlay.clubFrames[1].headBreakBefore, true);
const completeMeta = videoTimes.map((sourceTimeMs, frame) => ({ sourceTimeMs, frame }));
const completeSample = { clubTimeSource: 'video_pts', clubFrames: [0, 3, 5].map(frame => ({
  frame, timeMs: Math.round(videoTimes[frame]), head: seen, handle: seen,
})) };
const complete = markGaps(completeSample, completeMeta, videoTimes);
assert.equal(complete.verified, true);
assert.equal(complete.missingFrames, 0);
assert.equal(complete.overlay.clubFrames[1].timeMs,videoTimes[3]);
assert.equal(complete.overlay.clubFrames[2].timeMs,videoTimes[5]);
assert.equal(complete.overlay.clubFrames.some(row=>row.headBreakBefore||row.handleBreakBefore),false,'intentional sampling is not a source gap');
const prior = structuredClone(overlay);
prior.clubFrames[0].headValidUntilMs = 16.667;
assert.equal(markGaps(prior, meta, videoTimes).overlay.clubFrames[0].headValidUntilMs, 16.667, 'an earlier known detector gap wins');
for (const [badOverlay, badMeta, badClock] of [
  [overlay, meta.map((row, i) => i === 1 ? { ...row, sourceTimeMs: null } : row), videoTimes],
  [overlay, meta, [0, 16.667, 16.667, 50]],
  [overlay, meta, [0, 1, 33.333, 50, 66.667]],
  [{ ...overlay, clubFrames: overlay.clubFrames.map((row, i) => i === 1 ? { ...row, frame: 99 } : row) }, meta, videoTimes],
  [{ ...overlay, clubTimeSource: undefined }, meta, videoTimes],
  [{ ...overlay, clubFrames: overlay.clubFrames.map((row,i)=>i===1?{...row,headValidUntilMs:20}:row) }, meta, videoTimes],
]) {
  assert.equal(markGaps(badOverlay, badMeta, badClock).verified, false, 'unverified source frames must not be labelled as verified');
}

{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'club-source-coverage-'));
  try {
    const metaPath=path.join(dir,'meta.json'), inputPath=path.join(dir,'video.mp4');
    fs.writeFileSync(metaPath,JSON.stringify({frames:meta})); fs.writeFileSync(inputPath,'video fixture');
    const metaIdentity=fs.lstatSync(metaPath), videoIdentity=fs.statSync(inputPath);
    Object.assign(context,{fs,resolveMetaPath:p=>p===metaPath?p:null,matchesVideoIdentity:cacheModule.matchesVideoIdentity});
    const args={jobId:'job',metaPath,metaIdentity,inputPath,videoIdentity,overlay,
      impact:{jobId:'job',timingRevision:3,videoSha256:'a'.repeat(64),frameTimesMs:videoTimes}};
    const result=await context.verifyClubSourceCoverage(args);
    assert.equal(result.status,'verified');assert.equal(result.missingFrames,2);
    assert.equal(result.overlay.clubFrames[1].headValidUntilMs,33.333);
    assert.equal((await context.verifyClubSourceCoverage({...args,impact:{...args.impact,jobId:'other'}})).status,'unverified');
    assert.equal((await context.verifyClubSourceCoverage({...args,metaPath:'/outside'})).status,'unverified');
    fs.appendFileSync(inputPath,' changed');
    assert.equal((await context.verifyClubSourceCoverage(args)).status,'unverified','a changed video must not reuse its source clock');
    args.videoIdentity=fs.statSync(inputPath);
    fs.appendFileSync(metaPath,' ');
    assert.equal((await context.verifyClubSourceCoverage(args)).status,'unverified','changed metadata must not be marked verified');
    const link=path.join(dir,'link.json');fs.symlinkSync(metaPath,link);
    context.resolveMetaPath=p=>p===link?p:null;
    assert.equal((await context.verifyClubSourceCoverage({...args,metaPath:link,metaIdentity:fs.lstatSync(link)})).status,'unverified','metadata symlinks are not accepted');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}

let probeCalls = 0;
Object.assign(context, {
  path,
  matchesVideoIdentity: cacheModule.matchesVideoIdentity,
  fs: { promises: { stat: async () => ({ dev: 1, ino: 7, size: 20, mtimeMs: 30, ctimeMs: 40 }) } },
  impactReviews: { read: () => ({ inputPath: "/video.mp4", dev: 1, ino: 7, size: 20, mtimeMs: 30, ctimeMs: 40, result: { timingRevision: 2, frameTimesMs: [0, 16.667, 33.333, 50] } }) },
  ensureFfmpegAvailability: async () => ({ ffprobe: true }),
  runCommand: async () => { probeCalls += 1; return { stdout: JSON.stringify({ frames: [{ best_effort_timestamp_time: "0" }, { best_effort_timestamp_time: ".016667" }, { best_effort_timestamp_time: ".033333" }, { best_effort_timestamp_time: ".050" }] }) }; },
});
let timeline = await context.debugSourceTimeline("job", "/video.mp4", frames);
assert.deepEqual(Array.from(timeline.indices), [0, 2, 3]);
assert.equal(timeline.sourceAligned, true);
assert.equal(probeCalls, 0, "A matching cached video timeline can be reused.");
context.impactReviews.read = () => ({ inputPath: "/video.mp4", dev: 1, ino: 7, size: 20, mtimeMs: 30, ctimeMs: 40, result: { timingRevision: 3, frameTimesMs: [0, 16.667, 33.333, 50] } });
timeline = await context.debugSourceTimeline("job", "/video.mp4", frames);
assert.deepEqual(Array.from(timeline.indices), [0, 2, 3]);
assert.equal(probeCalls, 0, "The new timing revision can reuse the same verified source clock.");
context.impactReviews.read = () => ({ inputPath: "/video.mp4", size: 20, mtimeMs: 30, result: { timingRevision: 2, frameTimesMs: [0, 16.667, 33.333, 50] } });
timeline = await context.debugSourceTimeline("job", "/video.mp4", frames);
assert.deepEqual(Array.from(timeline.indices), [0, 2, 3]);
assert.equal(probeCalls, 1, "Older caches without full file identity must use a fresh probe.");
context.impactReviews.read = () => ({ inputPath: "/video.mp4", dev: 1, ino: 7, size: 20, mtimeMs: 30, ctimeMs: 40, result: { timingRevision: 3, frameTimesMs: [0, 16.667, 33.333, 50] } });
const legacy = await context.debugSourceTimeline("job", "/video.mp4", [{}, {}, {}]);
assert.deepEqual(Array.from(legacy.indices), [0, 1, 2]);
assert.equal(legacy.sourceAligned, false, "A video clock does not verify old model detections.");
const unmatched = await context.debugSourceTimeline("job", "/video.mp4", [{ sourceTimeMs: 0 }, { sourceTimeMs: 40 }]);
assert.equal(unmatched.sourceAligned, false, "Unmatched inference timestamps must not claim alignment.");
context.impactReviews.read = () => ({ inputPath: "/other.mp4", size: 20, mtimeMs: 30, result: { timingRevision: 2, frameTimesMs: [0, 33, 50] } });
timeline = await context.debugSourceTimeline("job", "/video.mp4", frames);
assert.deepEqual(Array.from(timeline.indices), [0, 2, 3]);
assert.equal(probeCalls, 2, "A timeline from a different video must not be reused.");
context.runCommand = async () => ({ stdout: JSON.stringify({ frames: [{ best_effort_timestamp_time: ".125" }, { best_effort_timestamp_time: ".141667" }, { best_effort_timestamp_time: ".158333" }, { best_effort_timestamp_time: ".175" }] }) });
timeline = await context.debugSourceTimeline("job", "/video.mp4", frames);
assert.deepEqual(Array.from(timeline.indices), [0, 2, 3], "Nonzero initial video PTS must be relative to playback start.");
context.runCommand = async () => ({ stdout: JSON.stringify({ frames: [{}, { best_effort_timestamp_time: "0.033" }] }) });
assert.equal(await context.debugSourceTimeline("job", "/video.mp4", frames), null, "Missing video timestamps must leave the mapping unverified.");

console.log(`debug frame timeline check passed (${jobId})`);
