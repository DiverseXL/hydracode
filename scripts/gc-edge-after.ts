/**
 * Post-GC verification: given the stale node ids captured BEFORE an
 * edit+re-index run (see gc-edge-before.ts), confirm DETACH DELETE removed
 * the stale nodes AND every edge pointing at them (CALLS/CONTAINS/METHOD_OF).
 * Also prints node/edge totals so count-flatness can be checked.
 *
 * Usage: npx tsx scripts/gc-edge-after.ts <stale-ids.json>
 * where the JSON file is an array of numbers (the stale ids).
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { HydraClient, unwrapValue } from "../src/hydra/client.js";

async function main(): Promise<void> {
  const idsFile = process.argv[2];
  if (!idsFile) throw new Error("usage: npx tsx scripts/gc-edge-after.ts <stale-ids.json>");
  const staleIds = new Set<number>(JSON.parse(readFileSync(idsFile, "utf8")) as number[]);
  console.log(`checking edges pointing at ${staleIds.size} previously-stale ids...`);

  const client = new HydraClient(loadConfig());

  const count = async (label: string, query: string): Promise<number> => {
    const res = await client.query(query, undefined, { consistency: "strong" });
    const value = unwrapValue(res.rows[0]?.[0]);
    console.log(`${label}: ${String(value)}`);
    return typeof value === "number" ? value : 0;
  };

  const countEdgesToStale = async (rel: string): Promise<number> => {
    const res = await client.query(
      `MATCH (a)-[r:${rel}]->(b) RETURN b.id AS toId`,
      undefined,
      { consistency: "strong" },
    );
    let toStale = 0;
    for (const row of res.rows) {
      const toId = unwrapValue((row as unknown[])[0]);
      if (typeof toId === "number" && staleIds.has(toId)) toStale++;
    }
    return toStale;
  };

  console.log("--- edges pointing at previously-stale ids (expect 0) ---");
  for (const rel of ["CALLS", "CONTAINS", "METHOD_OF", "IMPORTS", "EXTENDS"]) {
    const n = await countEdgesToStale(rel);
    console.log(`${rel} -> stale: ${n}`);
  }

  console.log("--- totals ---");
  await count("Function nodes", "MATCH (n:Function) RETURN count(*) AS total");
  await count("ClassEntity nodes", "MATCH (n:ClassEntity) RETURN count(*) AS total");
  await count("Test nodes", "MATCH (n:Test) RETURN count(*) AS total");
  await count("CALLS edges", "MATCH ()-[r:CALLS]->() RETURN count(*) AS total");
  await count("CONTAINS edges", "MATCH ()-[r:CONTAINS]->() RETURN count(*) AS total");
  await count("METHOD_OF edges", "MATCH ()-[r:METHOD_OF]->() RETURN count(*) AS total");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
