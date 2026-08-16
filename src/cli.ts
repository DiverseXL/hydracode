#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

program
  .name("hydracode")
  .description(
    "Index a codebase into a HydraDB graph for AI coding agents: multi-hop, relationship-aware context plus a temporal memory layer.",
  )
  .version("0.1.0");

program
  .command("index")
  .description("Index the current codebase into HydraDB")
  .action(() => {
    console.log("index: not implemented yet");
  });

program
  .command("ask")
  .description("Query the HydraDB graph for relationship-aware context")
  .action(() => {
    console.log("ask: not implemented yet");
  });

program
  .command("memory")
  .description("Work with the temporal memory layer")
  .action(() => {
    console.log("memory: not implemented yet");
  });

program
  .command("mcp")
  .description("Run the Model Context Protocol server")
  .action(() => {
    console.log("mcp: not implemented yet");
  });

program
  .command("status")
  .description("Show HydraDB connection status")
  .action(() => {
    console.log("status: not implemented yet");
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
