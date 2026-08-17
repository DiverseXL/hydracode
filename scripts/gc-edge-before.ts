/**
 * Capture the "before" state for GC edge-removal verification: the current
 * Function/Class/Test ids CONTAINS-linked to a given file (which will become
 * stale after an edit shifts their startLines), and every CALLS/CONTAINS/
 * METHOD_OF edge endpoint pair, so edges pointing at stale ids can be counted
 * before and after a re-index+GC run.
 *
 * Usage: npx tsx scripts/gc-edge-before.ts <repo-relative-file-path>
 * Prints JSON with: staleCandidateIds, callsToStale, containsToStale,
 * methodOfToStale, callsTotal, containsTotal, methodOfTotal, epoch.
 */
import { loadConfig } from "../src/config.js";
import { HydraClient, unwrapValue } from "../src/hydra/client.js";

async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) throw new Error("usage: npx tsx scripts/gc-edge-before.ts <file-path>");

  const client = new HydraClient(loadConfig());
  const out: Record<string, unknown> = {};

  // Current node ids CONTAINS-linked to this file — after an edit these are
  // the stale ids (their startLine shifts, so the extractor emits NEW ids).
  const containsRes = await client.query(
    `MATCH (f:File {path: $path})-[:CONTAINS]->(n) RETURN n.id AS id`,
    { path: filePath },
    { consistency: "strong" },
  );
  const staleCandidateIds = new Set<number>();
  for (const row of containsRes.rows) {
    const id = unwrapValue((row as unknown[])[0]);
    if (typeof id === "number") staleCandidateIds.add(id);
  }
  out.staleCandidateIds = [...staleCandidateIds];

  const countEdgesTo = async (rel: string): Promise<{ total: number; toStale: number; epoch: unknown }> => {
    const res = await client.query(
      `MATCH (a)-[r:${rel}]->(b) RETURN a.id AS fromId, b.id AS toId`,
      undefined,
      { consistency: "strong" },
    );
    let total = 0;
    let toStale = 0;
    for (const row of res.rows) {
      const fromId = unwrapValue((row as unknown[])[0]);
      const toId = unwrapValue((row as unknown[])[1]);
      if (typeof fromId === "number" && typeof toId === "number") {
        total++;
        if (staleCandidateIds.has(toId)) toStale++;
      }
    }
    return { total, toStale, epoch: res.raw };
  };

  out.calls = await countEdgesTo("CALLS");
  out.contains = await countEdgesTo("CONTAINS");
  out.methodOf = await countEdgesTo("METHOD_OF");

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
