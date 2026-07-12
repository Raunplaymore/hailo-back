import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../server.js", import.meta.url), "utf8");

for (const fragment of [
  "const eventsWithheldForQuality = result.eventValidation?.status === 'withheld';",
  "(hasEvent || eventsWithheldForQuality) &&",
]) {
  assert(source.includes(fragment), `quality-withheld infer result support missing: ${fragment}`);
}

console.log("quality-withheld infer result check passed");
