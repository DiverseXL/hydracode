#!/usr/bin/env node

import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { loadConfig } from "./config.js";
import { extractRepo } from "./extract/tsExtractor.js";
import { runAskPipeline, describeKey, chainDisplay } from "./graph/askPipeline.js";
import type { AskResultNode, AskEvidencePath } from "./graph/askPipeline.js";
import { getGraphStatus, MAX_HOPS } from "./graph/query.js";
import { writeExtractedFiles } from "./graph/writer.js";
import { HydraClient } from "./hydra/client.js";
import { HydraConnectionError, HydraQueryError } from "./hydra/errors.js";

const program = new Command();

program
  .name("hydracode")
  .description(
    "Index a codebase into a HydraDB graph for AI coding agents: multi-hop, relationship-aware context plus a temporal memory layer.",
  )
  .version("0.1.0");

const DEFAULT_INDEX_PATTERNS = "**/*.{ts,tsx,js,jsx}";

/** Commander collect callback for repeatable --pattern flags. */
function collectPattern(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

program
  .command("index")
  .description("Index the current codebase into HydraDB")
  .option("--path <dir>", "directory to index (default: current directory)", ".")
  .option(
    "--pattern <glob>",
    "file glob to index (repeatable; default: **/*.{ts,tsx,js,jsx})",
    collectPattern,
    [],
  )
  .option("--quiet", "suppress progress spinners")
  .action(async (opts: { path: string; pattern: string[]; quiet: boolean }) => {
    const repoRoot = path.resolve(opts.path);
    const patterns =
      opts.pattern.length > 0 ? opts.pattern : undefined;
    const quiet = opts.quiet;

    try {
      const config = loadConfig();
      const client = new HydraClient(config);

      console.log(pc.bold("hydracode index"));
      console.log(
        pc.dim(`extracting: ${repoRoot} (${(patterns ?? [DEFAULT_INDEX_PATTERNS]).join(", ")})`),
      );
      const files = await extractRepo(repoRoot, patterns, { quiet });

      console.log(pc.dim(`writing ${files.length} files to ${config.httpUri}...`));
      const summary = await writeExtractedFiles(files, client, { quiet });

      console.log(pc.green("\nwrite summary:"));
      console.log(JSON.stringify(summary, null, 2));
    } catch (err) {
      if (err instanceof HydraConnectionError) {
        console.error(pc.red(`\nerror: ${err.message}`));
      } else if (err instanceof HydraQueryError) {
        console.error(
          pc.red(`\nerror: HydraDB rejected a query (HTTP ${err.status}): ${err.body}`),
        );
      } else {
        console.error(pc.red(`\nerror: ${err instanceof Error ? err.message : String(err)}`));
      }
      process.exitCode = 1;
    }
  });

program
  .command("ask")
  .description("Query the HydraDB graph for relationship-aware context")
  .argument("<question>", "natural-language question about the codebase")
  .option("--max-hops <n>", "max traversal depth (clamped to 3)", "3")
  .action(async (question: string, opts: { maxHops: string }) => {
    const client = new HydraClient(loadConfig());
    const maxHops = Math.min(Math.max(1, Number(opts.maxHops) || MAX_HOPS), MAX_HOPS);

    // Delegate to the shared pipeline. All graph queries and intent routing
    // live in graph/askPipeline.ts — this handler only handles CLI rendering.
    const result = await runAskPipeline(client, question, maxHops);

    if (result.parseError) {
      console.log(pc.yellow(result.parseError));
      return;
    }

    if (!result.resolved) {
      if (result.ambiguousCandidates && result.ambiguousCandidates.length > 0) {
        // Group candidates by name for display.
        const byName = new Map<string, typeof result.ambiguousCandidates>();
        for (const c of result.ambiguousCandidates) {
          const group = byName.get(c.name) ?? [];
          group.push(c);
          byName.set(c.name, group);
        }
        console.log(pc.bold("Multiple matches — be more specific:"));
        for (const [name, candidates] of byName) {
          console.log(pc.cyan(`  "${name}" matched ${candidates.length} nodes:`));
          candidates.forEach((c, i) => {
            console.log(`    ${i + 1}. ${describeKey(c.key)}`);
          });
        }
        console.log(
          pc.dim(
            "Re-run with a more specific name (e.g. the exact function or file path), and I'll pick the right one.",
          ),
        );
      } else {
        console.log(pc.yellow(result.notFound ?? "Not found."));
      }
      return;
    }

    // Resolved — render the heading.
    const intent = result.intent ?? "general";
    const anchorKey = result.anchor?.key ?? "";
    console.log(pc.bold(`\n${intentLabel(intent)} ${pc.cyan(describeKey(anchorKey))}`));

    // File shortcut message (no results list in this case).
    if (result.message && result.results?.length === 0 && result.anchor?.label === "File") {
      console.log(pc.dim(result.message));
      return;
    }

    // Render results.
    const results = result.results ?? [];
    if (intent === "callers") {
      printResultList("called by", results, maxHops);
      if (results.length === 0) {
        console.log(pc.dim("(no callers found)"));
      }
    } else if (intent === "callees") {
      printResultList("calls", results, maxHops);
    } else if (intent === "tests") {
      printResultList("covered by tests", results, 1);
      if (results.length === 0) {
        console.log(
          pc.dim("(no TESTS edges in the graph yet — the writer stores Test nodes but doesn't link them)"),
        );
      }
    } else {
      // general: results already merged (callees + tests).
      printResultList("calls / related", results, maxHops);
    }

    // Path evidence.
    const evidence = result.evidence ?? [];
    if (evidence.length > 0) {
      console.log(pc.bold(`\npaths from ${pc.cyan(describeKey(anchorKey))}`));
      for (const p of evidence) {
        // pathText uses → (U+2192); replace with coloured dim arrow for terminal.
        const rendered = p.pathText
          .split(" \u2192 ")
          .map((seg) => pc.green(seg))
          .join(pc.dim(" → "));
        console.log(
          `  ${rendered}${p.weight !== undefined ? pc.dim(`  (weight ${p.weight})`) : ""}`,
        );
      }
      if (evidence.length === 8 && (result.evidence?.length ?? 0) >= 8) {
        // Pipeline caps evidence at 8 paths; indicate there may be more.
        console.log(pc.dim("  … (capped at 8 paths)"));
      }
    }
  });

program
  .command("memory")
  .description("Work with the temporal memory layer")
  .action(() => {
    console.log("memory: not implemented yet");
  });

program
  .command("mcp")
  .description(
    "Start the MCP server on stdio (for use with Claude Code, Cursor, etc.)\n" +
    '  e.g. in mcp.json: { "command": "hydracode", "args": ["mcp"] }',
  )
  .action(async () => {
    // Import lazily so the import side-effects (module-level config attempt)
    // only run when the mcp command is actually invoked, not at parse time.
    // CRITICAL: nothing below this line may write to stdout — the MCP
    // transport owns stdout for the lifetime of the subprocess.
    const { startMcpServer } = await import("./mcp/server.js");
    await startMcpServer();
  });

program
  .command("status")
  .description("Show HydraDB connection status and graph counts")
  .action(async () => {
    try {
      const config = loadConfig();
      const client = new HydraClient(config);
      const status = await getGraphStatus(client);
      const { indexed, counts } = status;

      console.log(pc.bold("hydracode status"));
      console.log();
      console.log(
        `  Indexed:   ${indexed ? pc.green("yes") : pc.yellow("no")}`,
      );
      if (indexed) {
        const pad = (n: number) => String(n).padStart(4);
        console.log(`  Files:    ${pad(counts.files)}`);
        console.log(`  Functions:${pad(counts.functions)}`);
        console.log(`  Classes:  ${pad(counts.classes)}`);
        console.log(`  Tests:    ${pad(counts.tests)}`);
      } else {
        console.log(pc.dim("  Run `hydracode index .` to get started."));
      }
    } catch (err) {
      if (err instanceof HydraConnectionError) {
        console.error(pc.red(`\nerror: ${err.message}`));
      } else if (err instanceof HydraQueryError) {
        console.error(
          pc.red(`\nerror: HydraDB rejected a query (HTTP ${err.status}): ${err.body}`),
        );
      } else {
        console.error(pc.red(`\nerror: ${err instanceof Error ? err.message : String(err)}`));
      }
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});

/* ----------------------------- formatting ----------------------------- */

function intentLabel(intent: string): string {
  switch (intent) {
    case "callers":
      return "callers of";
    case "callees":
      return "what calls";
    case "tests":
      return "tests for";
    default:
      return "context for";
  }
}

// describeKey and chainDisplay are re-exported from graph/askPipeline.ts and
// imported at the top of this file — no local duplicates needed.
void chainDisplay; // referenced in evidence rendering above; suppress unused-import lint.

function printResultList(label: string, nodes: AskResultNode[], maxHops: number): void {
  if (nodes.length === 0) {
    console.log(pc.dim(`  ${label}: none found (within ${maxHops} hop${maxHops === 1 ? "" : "s"})`))
    return;
  }
  console.log(`  ${pc.bold(label)} (${nodes.length}):`);
  for (const n of nodes) {
    console.log(`    ${pc.green(n.display)}`);
  }
}

// Suppress unused-import warning for AskEvidencePath (used only as type annotation).
void (undefined as unknown as AskEvidencePath);
