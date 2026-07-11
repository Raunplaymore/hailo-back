import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../server.js", import.meta.url), "utf8");

const expectedFragments = [
  "coachFindings: Array.isArray(analysis.coachFindings) ? analysis.coachFindings : []",
  "coachFindings: result?.coachFindings ?? result?.coach_findings ?? result?.debug?.coachFindings ?? []",
  "coachFindings: result.coachFindings ?? result.coach_findings ?? result.debug?.coachFindings ?? []",
];

for (const fragment of expectedFragments) {
  assert(
    source.includes(fragment),
    `coachFindings pass-through fragment missing: ${fragment}`,
  );
}

const requiredFindingFields = [
  "evidence",
  "interpretation",
  "action",
  "drill",
  "checkpoint",
  "caution",
  "confidence",
  "theory",
];

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
for (const field of requiredFindingFields) {
  assert(
    readme.includes(field),
    `README must document coachFindings field pass-through for ${field}`,
  );
}

const forbiddenPatterns = [
  /coachFindings\s*:\s*[^,\n]+\.map\s*\(/,
  /coachFindings\s*:\s*[^,\n]+\.filter\s*\(/,
  /coachFindings\s*:\s*[^,\n]+\.reduce\s*\(/,
  /coachFindings\s*:\s*[^,\n]+\.pick\s*\(/,
  /coachFindings\s*:\s*[^,\n]+\.omit\s*\(/,
];

for (const pattern of forbiddenPatterns) {
  assert(
    !pattern.test(source),
    `coachFindings should not be rewritten in pi_service: ${pattern}`,
  );
}

console.log("coachFindings pass-through check passed");
