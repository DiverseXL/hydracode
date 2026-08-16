import pc from "picocolors";
import { loadConfig } from "../src/config.js";
import { extractRepo } from "../src/extract/tsExtractor.js";
import { writeExtractedFiles } from "../src/graph/writer.js";
import { HydraClient } from "../src/hydra/client.js";

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const patterns = ["src/**/*.{ts,tsx,js,jsx}"];

  console.log(pc.bold("hydracode index-self"));

  const config = loadConfig();
  const client = new HydraClient(config);

  console.log(pc.dim(`extracting: ${patterns.join(" ")}`));
  const files = await extractRepo(repoRoot, patterns);

  console.log(pc.dim(`writing ${files.length} files to ${config.httpUri}...`));
  const summary = await writeExtractedFiles(files, client);

  console.log(pc.green("\nwrite summary:"));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err: unknown) => {
  console.error(
    pc.red(`\nerror: ${err instanceof Error ? err.message : String(err)}`),
  );
  process.exitCode = 1;
});
