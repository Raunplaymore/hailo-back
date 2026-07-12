import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../server.js", import.meta.url), "utf8");

for (const fragment of [
  "const DEBUG_TRACK_VALIDATION = {",
  "golf_ball: { maxArea: 0.012, maxWidth: 0.14, maxHeight: 0.14 }",
  "club_handle: { maxArea: 0.06, maxWidth: 0.22, maxHeight: 0.18, maxWristDistance: 0.22 }",
  "reason: 'implausible_bbox_size'",
  "rejectedDetections.push({ ...det, rejectionReason: validation.reason });",
  "rejectedLabelCounts,",
]) {
  assert(source.includes(fragment), `debug detection validation missing: ${fragment}`);
}

console.log("debug detection filter check passed");
