import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../server.js", import.meta.url), "utf8");

for (const fragment of [
  "const resultStatus = mapInferStatus(resultRes.json?.status || resultRes.json?.state);",
  "if (resultStatus === 'running' || resultStatus === 'pending')",
  "message: 'infer 결과를 준비 중입니다.'",
  "return { status: 'running', analysis: cachedAnalysis, progress };",
]) {
  assert(source.includes(fragment), `pending infer-result guard missing: ${fragment}`);
}

console.log("infer pending-result guard check passed");
