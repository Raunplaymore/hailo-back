import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

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

let probeCalls = 0;
Object.assign(context, {
  path,
  fs: { promises: { stat: async () => ({ size: 20, mtimeMs: 30 }) } },
  impactReviews: { read: () => ({ inputPath: "/video.mp4", size: 20, mtimeMs: 30, result: { timingRevision: 2, frameTimesMs: [0, 16.667, 33.333, 50] } }) },
  ensureFfmpegAvailability: async () => ({ ffprobe: true }),
  runCommand: async () => { probeCalls += 1; return { stdout: JSON.stringify({ frames: [{ best_effort_timestamp_time: "0" }, { best_effort_timestamp_time: ".016667" }, { best_effort_timestamp_time: ".033333" }, { best_effort_timestamp_time: ".050" }] }) }; },
});
let timeline = await context.debugSourceTimeline("job", "/video.mp4", frames);
assert.deepEqual(Array.from(timeline.indices), [0, 2, 3]);
assert.equal(timeline.sourceAligned, true);
assert.equal(probeCalls, 0, "A matching cached video timeline can be reused.");
const legacy = await context.debugSourceTimeline("job", "/video.mp4", [{}, {}, {}]);
assert.deepEqual(Array.from(legacy.indices), [0, 1, 2]);
assert.equal(legacy.sourceAligned, false, "A video clock does not verify old model detections.");
const unmatched = await context.debugSourceTimeline("job", "/video.mp4", [{ sourceTimeMs: 0 }, { sourceTimeMs: 40 }]);
assert.equal(unmatched.sourceAligned, false, "Unmatched inference timestamps must not claim alignment.");
context.impactReviews.read = () => ({ inputPath: "/other.mp4", size: 20, mtimeMs: 30, result: { timingRevision: 2, frameTimesMs: [0, 33, 50] } });
timeline = await context.debugSourceTimeline("job", "/video.mp4", frames);
assert.deepEqual(Array.from(timeline.indices), [0, 2, 3]);
assert.equal(probeCalls, 1, "A timeline from a different video must not be reused.");
context.runCommand = async () => ({ stdout: JSON.stringify({ frames: [{ best_effort_timestamp_time: ".125" }, { best_effort_timestamp_time: ".141667" }, { best_effort_timestamp_time: ".158333" }, { best_effort_timestamp_time: ".175" }] }) });
timeline = await context.debugSourceTimeline("job", "/video.mp4", frames);
assert.deepEqual(Array.from(timeline.indices), [0, 2, 3], "Nonzero initial video PTS must be relative to playback start.");
context.runCommand = async () => ({ stdout: JSON.stringify({ frames: [{}, { best_effort_timestamp_time: "0.033" }] }) });
assert.equal(await context.debugSourceTimeline("job", "/video.mp4", frames), null, "Missing video timestamps must leave the mapping unverified.");

console.log(`debug frame timeline check passed (${jobId})`);
