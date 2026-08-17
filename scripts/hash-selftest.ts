/**
 * Self-test for graph/hashId.ts.
 *
 * The hash function is part of every node's on-disk identity: changing it
 * orphans every existing node in a live graph (re-index would write new ids
 * next to the old ones — effectively a schema migration). These pinned
 * examples let a future reader verify the function has NOT silently changed
 * after any edit. If a case fails, the hash changed; do not "fix" the test
 * without treating it as a migration.
 *
 * Run: npx tsx scripts/hash-selftest.ts
 */
import { hashToVertexId } from "../src/graph/hashId.js";

const CASES: Array<[string, number]> = [
  ["file:src/cli.ts", 6167140109164433],
  ["module:zod", 8686384327530822],
  ["function:src/hydra/client.ts#query#100", 8342594248591468],
  ["class:src/graph/writer.ts#WriteSummary", 6821322101997439],
];

let failed = 0;
for (const [input, expected] of CASES) {
  const actual = hashToVertexId(input);
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"} hashToVertexId(${JSON.stringify(input)}) = ${actual}` +
      (ok ? "" : ` (expected ${expected})`),
  );
}

if (failed > 0) {
  console.error(
    `\n${failed} case(s) failed — hashToVertexId changed behavior. ` +
      "A changed hash orphans every node in a live graph; treat as a schema migration.",
  );
  process.exitCode = 1;
} else {
  console.log("\nhash selftest passed — hashToVertexId is stable.");
}
