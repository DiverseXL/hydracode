import pc from "picocolors";
import { loadConfig } from "../src/config.js";
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

  console.log(pc.bold("\n2. query('RETURN 1 AS one')"));
  const result = await client.query("RETURN 1 AS one");
  console.log(pc.dim("raw response:"));
  console.log(JSON.stringify(result.raw, null, 2));
  console.log(pc.dim("unwrapped rows:"));
  console.log(JSON.stringify(result.rows.map((row) => unwrapValue(row)), null, 2));

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
