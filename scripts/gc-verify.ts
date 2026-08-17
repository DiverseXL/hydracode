/**
 * GC verification helper: print current node/edge counts so GC behavior can
 * be checked before/after a re-index run (used by the writer's garbage
 * collection verification — see src/graph/writer.ts gcStaleNodes).
 *
 * Usage: npx tsx scripts/gc-verify.ts
 */
import { loadConfig } from "../src/config.js";
import { HydraClient, unwrapValue } from "../src/hydra/client.js";

async function main(): Promise<void> {
  const client = new HydraClient(loadConfig());

  const queries: Array<[string, string]> = [
    ["Function nodes", "MATCH (n:Function) RETURN count(*) AS total"],
    ["ClassEntity nodes", "MATCH (n:ClassEntity) RETURN count(*) AS total"],
    ["Test nodes", "MATCH (n:Test) RETURN count(*) AS total"],
    ["CALLS edges", "MATCH ()-[r:CALLS]->() RETURN count(*) AS total"],
    ["CONTAINS edges", "MATCH ()-[r:CONTAINS]->() RETURN count(*) AS total"],
  ];

  for (const [label, cypher] of queries) {
    const res = await client.query(cypher, undefined, { consistency: "strong" });
    const count = unwrapValue(res.rows[0]?.[0]);
    console.log(`${label}: ${String(count)}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
