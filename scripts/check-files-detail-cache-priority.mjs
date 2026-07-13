#!/usr/bin/env node

import fs from "node:fs";

const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

const required = [
  "const effectiveStatus =",
  "cachedFileStatus ||",
  "const effectiveAnalysis = cached ? cachedAnalysis",
  "analyzed: effectiveStatus === 'succeeded'",
  "status: effectiveStatus",
  "analysis: effectiveAnalysis",
];

for (const snippet of required) {
  if (!source.includes(snippet)) {
    throw new Error(`files/detail must prefer the latest cache: missing ${snippet}`);
  }
}

console.log("files/detail cache priority check passed");
