import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const jobId = "957e5457-4d13-46bf-88c6-65c467af8487";
const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
const match = source.match(/function frameTimeMs\([\s\S]*?\n}\n\nfunction selectDebugFrames/);
assert(match, "frameTimeMs implementation not found");

const context = {};
vm.runInNewContext(`${match[0].replace(/\n\nfunction selectDebugFrames$/, "")}; this.frameTimeMs = frameTimeMs;`, context);

const fps = 29.97002997002997;
for (const [frame, expectedTimeMs] of [[94, 3136], [34, 1132], [65, 2164], [73, 2431], [77, 2564]]) {
  const actual = context.frameTimeMs({ frame, timeMs: Math.round((frame * 954) / 94) }, frame, fps);
  assert.ok(Math.abs(actual - expectedTimeMs) <= 80, `${jobId}: frame ${frame} must use the video frame clock, got ${actual}`);
}

console.log(`debug frame timeline check passed (${jobId})`);
