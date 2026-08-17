import pc from "picocolors";
import { loadConfig } from "../src/config.js";
import { NODE_LABELS } from "../src/graph/schema.js";
import { HydraClient, unwrapValue } from "../src/hydra/client.js";
import {
  HydraConnectionError,
  HydraQueryError,
} from "../src/hydra/errors.js";

async function main(): Promise<void> {
  console.log(pc.bold("hydracode smoke test"));

  const config = loadConfig();
  console.log(
    `${pc.dim("HydraDB:")} ${config.httpUri} ` +
      `(graph=${config.graph}, namespace=${config.namespace}, ` +
      `cell=${config.cellId}, plaintext=${config.allowPlaintext})`,
  );

  const client = new HydraClient(config);

  console.log(pc.bold("\n1. healthCheck()"));
  const healthy = await client.healthCheck();
  console.log(healthy ? pc.green("healthy") : pc.yellow("not healthy"));

  console.log(
    pc.bold("\n2. node counts per label: MATCH (n:<Label>) RETURN count(*) AS total"),
  );
  // Bare `MATCH (n)` is rejected (needs an id/label/property predicate) and
  // `count(n)` is unsupported (only `count(*)`), so count per known label.
  let totalNodes = 0;
  const labels = Object.values(NODE_LABELS);
  for (const label of labels) {
    const res = await client.query(`MATCH (n:${label}) RETURN count(*) AS total`);
    const count = unwrapValue(res.rows[0]?.[0]);
    if (label === labels[0]) {
      console.log(pc.dim("raw response (first label):"));
      console.log(JSON.stringify(res.raw, null, 2));
      console.log(pc.dim("unwrapped rows:"));
      console.log(JSON.stringify(res.rows.map((row) => unwrapValue(row)), null, 2));
    }
    console.log(`  ${label}: ${String(count)}`);
    totalNodes += typeof count === "number" ? count : 0;
  }
  console.log(pc.bold(`  total nodes across all labels: ${totalNodes}`));

  console.log(
    pc.bold("\n3. parameterized: query('MATCH (n:File) WHERE n.id = $testId RETURN n.id')"),
  );
  const paramResult = await client.query(
    "MATCH (n:File) WHERE n.id = $testId RETURN n.id",
    { testId: "smoke-test-nonexistent" },
  );
  console.log(pc.dim("raw response:"));
  console.log(JSON.stringify(paramResult.raw, null, 2));
  console.log(pc.dim("unwrapped rows:"));
  console.log(JSON.stringify(paramResult.rows.map((row) => unwrapValue(row)), null, 2));
  console.log(
    pc.dim(
      `rows returned: ${paramResult.rows.length} (expected 0 — no File has id "smoke-test-nonexistent")`,
    ),
  );

  console.log(pc.green("\nsmoke test passed"));
}

main().catch((err: unknown) => {
  if (err instanceof HydraConnectionError) {
    console.error(pc.red(`\nconnection error: ${err.message}`));
  } else if (err instanceof HydraQueryError) {
    console.error(
      pc.red(`\nquery error (HTTP ${err.status}): ${err.body || err.message}`),
    );
  } else {
    console.error(
      pc.red(`\nerror: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  process.exitCode = 1;
});
