#!/usr/bin/env node

import fs from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import fg from "fast-glob";
import { loadConfig } from "./config.js";
import { extractRepo, extractFile } from "./extract/tsExtractor.js";
import { runAskPipeline, describeKey, chainDisplay } from "./graph/askPipeline.js";
import type { AskResultNode, AskEvidencePath } from "./graph/askPipeline.js";
import { runInstall } from "./install.js";
import { getGraphStatus, MAX_HOPS } from "./graph/query.js";
import { buildGraphSummary, renderAgentsMdSection, MARKER_START, MARKER_END } from "./graph/agentsSummary.js";
import { checkDuplicateRisk, functionNameFromKey } from "./graph/duplicateCheck.js";
import { recordKnownDuplicate, recordMemoryFactAbout, recallMemoryFacts } from "./memory/store.js";
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
  .option("--watch", "watch for changes and incrementally reindex")
  .option("--changed-only", "index only files changed in the most recent commit")
  .action(async (opts: { path: string; pattern: string[]; quiet: boolean; watch?: boolean; changedOnly?: boolean }) => {
    const repoRoot = path.resolve(opts.path);
    const activePatterns = opts.pattern.length > 0 ? opts.pattern : [DEFAULT_INDEX_PATTERNS];
    const quiet = opts.quiet;

    try {
      const config = loadConfig();
      const client = new HydraClient(config);

      const incrementalIndex = async (filePaths: string[]) => {
        const existingFiles = filePaths.filter(f => fs.existsSync(f));
        const deletedFiles = filePaths.filter(f => !fs.existsSync(f));
        
        for (const deleted of deletedFiles) {
          console.log(pc.yellow(`file deleted: ${deleted} — stale graph nodes for this file are not automatically removed yet`));
        }
        
        if (existingFiles.length === 0) return;
        
        const extracted = [];
        for (const f of existingFiles) {
          extracted.push(await extractFile(f, repoRoot));
        }
        
        const start = Date.now();
        await writeExtractedFiles(extracted, client, { quiet: true });
        const ms = Date.now() - start;
        console.log(pc.green(`reindexed ${extracted.length} file(s) in ${ms}ms`));
      };

      if (opts.changedOnly) {
        console.log(pc.bold("hydracode index --changed-only"));
        try {
          let diffOutput = "";
          try {
            diffOutput = execSync("git diff --name-only HEAD~1 HEAD", { cwd: repoRoot, encoding: "utf8" });
          } catch {
            // fallback for first commit or detached head
            diffOutput = execSync("git ls-files", { cwd: repoRoot, encoding: "utf8" });
          }
          
          const changedFiles = diffOutput.split('\n').map(l => l.trim()).filter(Boolean);
          const changedAbs = changedFiles.map(f => path.join(repoRoot, f));
          
          const allMatched = fg.sync(activePatterns, { cwd: repoRoot, absolute: true, dot: true });
          const matchedSet = new Set(allMatched.map(f => path.normalize(f)));
          const matchedFiles = changedAbs.filter(f => matchedSet.has(path.normalize(f)));
          
          if (matchedFiles.length === 0) {
            console.log(pc.dim("no changed files match indexing patterns."));
          } else {
            await incrementalIndex(matchedFiles);
          }
        } catch (err) {
          console.log(pc.yellow(`failed to determine changed files (${err}), falling back to full index`));
          const files = await extractRepo(repoRoot, activePatterns, { quiet });
          const summary = await writeExtractedFiles(files, client, { quiet });
          console.log(pc.green("\nwrite summary:"));
          console.log(JSON.stringify(summary, null, 2));
        }
        return;
      }

      console.log(pc.bold("hydracode index"));
      console.log(pc.dim(`extracting: ${repoRoot} (${activePatterns.join(", ")})`));
      const files = await extractRepo(repoRoot, activePatterns, { quiet });

      console.log(pc.dim(`writing ${files.length} files to ${config.httpUri}...`));
      const summary = await writeExtractedFiles(files, client, { quiet });

      console.log(pc.green("\nwrite summary:"));
      console.log(JSON.stringify(summary, null, 2));

      if (opts.watch) {
        console.log(pc.blue(`\nWatching for changes in ${repoRoot}...`));
        const changedPaths = new Set<string>();
        let debounceTimer: NodeJS.Timeout | null = null;
        
        fs.watch(repoRoot, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          const absPath = path.join(repoRoot, filename);
          if (absPath.includes("node_modules") || absPath.includes(".git") || absPath.includes(".hydracode")) return;
          
          const normalized = path.normalize(absPath);
          const allMatched = fg.sync(activePatterns, { cwd: repoRoot, absolute: true, dot: true });
          const matchedSet = new Set(allMatched.map(f => path.normalize(f)));
          
          if (matchedSet.has(normalized)) {
            changedPaths.add(absPath);
            
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
              const pathsToProcess = Array.from(changedPaths);
              changedPaths.clear();
              try {
                await incrementalIndex(pathsToProcess);
              } catch (e) {
                console.error(pc.red(`watch reindex failed: ${e}`));
              }
            }, 400);
          }
        });
        
        // Keep alive
        await new Promise(() => {});
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
        // Triplet format `[a] -[:CALLS]-> [b]` when rels were available;
        // fall back to the plain → arrow chain otherwise.
        const rendered = p.pathText.includes(" -[")
          ? p.pathText
              .replace(/\[([^\]]+)\]/g, (_m, name: string) => pc.green(`[${name}]`))
              .replace(/( -\[:[^\]]+\]-> )/g, (_m, sep: string) => pc.dim(sep))
          : p.pathText
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
  .command("install")
  .description(
    "Install hydracode as an MCP server for Cursor and/or Claude Code — writes/updates " +
      "their MCP config files so an agent picks up hydracode automatically",
  )
  .action(async () => {
    await runInstall();
  });

const memoryCmd = program
  .command("memory")
  .description("Record and recall decisions in the temporal memory layer");

memoryCmd
  .command("record")
  .description("Record a project decision, convention, or rationale in the memory layer")
  .argument("<text>", "the decision/note text to record")
  .option("--about <name>", "function/class/file name to link this fact to via ABOUT")
  .action(async (text: string, opts: { about?: string }) => {
    try {
      const config = loadConfig();
      const client = new HydraClient(config);

      console.log(pc.bold("hydracode memory record"));
      console.log();

      const { recorded, about } = await recordMemoryFactAbout(client, text, opts.about);
      console.log(pc.green(`Recorded: ${recorded.key}`));
      console.log(pc.dim(`  ${recorded.text}`));
      console.log(pc.dim(`  createdAt: ${recorded.createdAt}`));
      if (about.length > 0) {
        console.log(pc.dim(`  about: ${about.map((a) => a.key).join(", ")}`));
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

memoryCmd
  .command("recall")
  .description(
    "Recall recorded decisions matching a query, or all facts linked to a node via --about",
  )
  .argument("<query>", "search text (ignored when --about is given)")
  .option("--about <name>", "only recall facts linked to this function/class/file")
  .action(async (query: string, opts: { about?: string }) => {
    try {
      const config = loadConfig();
      const client = new HydraClient(config);

      console.log(pc.bold("hydracode memory recall"));
      console.log();

      const facts = await recallMemoryFacts(client, { query, about: opts.about });
      if (facts.length === 0) {
        console.log(pc.dim("no matching facts found"));
      } else {
        for (const f of facts) {
          console.log(`  ${pc.green(f.key)} ${pc.dim(`(${f.createdAt})`)}`);
          console.log(`    ${f.text}`);
          if (f.about.length > 0) {
            console.log(pc.dim(`    about: ${f.about.join(", ")}`));
          }
        }
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

program
  .command("init-hooks")
  .description("Install git post-commit hook for auto-reindexing")
  .action(() => {
    try {
      execSync("git rev-parse --git-dir", { stdio: "ignore" });
    } catch {
      console.error(pc.red("error: not a git repository"));
      process.exitCode = 1;
      return;
    }
    
    const repoRoot = process.cwd();
    const cliPath = path.join(repoRoot, "dist", "cli.js");
    const nodeExec = process.execPath;
    
    const gitDir = execSync("git rev-parse --git-dir", { encoding: "utf8" }).trim();
    const hookPath = path.join(gitDir, "hooks", "post-commit");
    
    let hookContent = "";
    if (fs.existsSync(hookPath)) {
      hookContent = fs.readFileSync(hookPath, "utf8");
      if (hookContent.includes("# >>> hydracode post-commit >>>")) {
        console.log(pc.green("hydracode post-commit hook is already installed."));
        return;
      }
    } else {
      hookContent = "#!/bin/sh\n\n";
    }
    
    const hookBlock = `
# >>> hydracode post-commit >>>
# Runs synchronously (~400ms). Fails silently if hydracode is unavailable.
node "${cliPath.replace(/\\/g, '/')}" index --changed-only >> .git/hydracode-reindex.log 2>&1 || true
# <<< hydracode post-commit <<<
`;
    fs.writeFileSync(hookPath, hookContent + hookBlock);
    
    try {
      execSync(`chmod +x "${hookPath}"`, { stdio: "ignore" });
    } catch {}
    
    console.log(pc.green(`Successfully installed hydracode post-commit hook to ${hookPath}`));
  });

program
  .command("sync-agents-md")
  .description("Generate or update AGENTS.md with graph-derived facts")
  .action(async () => {
    try {
      const config = loadConfig();
      const client = new HydraClient(config);

      console.log(pc.bold("hydracode sync-agents-md"));
      console.log();

      const summary = await buildGraphSummary(client);
      const mdSection = renderAgentsMdSection(summary);
      const agentsPath = path.join(process.cwd(), "AGENTS.md");

      let newContent: string;
      let changeType: string;

      if (!fs.existsSync(agentsPath)) {
        // File does not exist — create it with a header comment + generated section.
        newContent =
          `# AGENTS.md\n` +
          `# Add your project conventions, architecture notes, and rules above or below\n` +
          `# the auto-generated section. hydracode will preserve everything outside the markers.\n` +
          `\n` +
          mdSection +
          `\n`;
        changeType = "Created";
      } else {
        const existing = fs.readFileSync(agentsPath, "utf8");
        const startIdx = existing.indexOf(MARKER_START);
        const endIdx = existing.indexOf(MARKER_END);
        const hasStart = startIdx !== -1;
        const hasEnd = endIdx !== -1;

        if (hasStart && hasEnd && endIdx > startIdx) {
          // Replace only the block between (and including) the markers.
          newContent =
            existing.slice(0, startIdx) +
            mdSection +
            existing.slice(endIdx + MARKER_END.length);
          changeType = "Replaced existing auto-generated section in";
        } else if (!hasStart && !hasEnd) {
          // No markers present — append.
          newContent = existing.trimEnd() + "\n\n" + mdSection + "\n";
          changeType = "Appended new auto-generated section to";
        } else {
          // Exactly one marker present — corrupted state, refuse to touch.
          console.error(
            pc.red(
              `\nerror: AGENTS.md contains only one of the two hydracode markers.\n` +
              `  Start marker ${hasStart ? "found" : "MISSING"}: ${MARKER_START}\n` +
              `  End marker   ${hasEnd ? "found" : "MISSING"}: ${MARKER_END}\n` +
              `\n` +
              `  Please fix or remove the partial markers manually,\n` +
              `  then run \`hydracode sync-agents-md\` again.`,
            ),
          );
          process.exitCode = 1;
          return;
        }
      }

      fs.writeFileSync(agentsPath, newContent, "utf8");
      console.log(pc.green(`${changeType}: ${agentsPath}`));
      console.log();
      console.log(`  Aggregation: ${summary.aggregationStrategy}`);
      console.log(`  Files indexed: ${summary.counts.files}`);
      console.log(`  Functions indexed: ${summary.counts.functions}`);
      console.log(`  High fan-in functions listed: ${summary.highFanIn.length}`);
      console.log(`  Most-connected files listed: ${summary.mostConnected.length}`);
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
  .command("check-duplicate")
  .description("Check whether a proposed function name may duplicate existing code in the graph")
  .argument("<proposedName>", "name of the function you are about to write")
  .option("--file <path>", "target file the new function would live in (same-file check hint)")
  .option("--record <reason>", "record a deliberate-duplicate decision in the memory layer with this reason")
  .action(async (proposedName: string, opts: { file?: string; record?: string }) => {
    try {
      const config = loadConfig();
      const client = new HydraClient(config);

      console.log(pc.bold("hydracode check-duplicate"));
      console.log();
      console.log(
        `  proposed: ${pc.cyan(proposedName)}` +
          (opts.file ? ` (target file: ${pc.dim(opts.file)})` : ""),
      );
      console.log();

      const result = await checkDuplicateRisk(
        client,
        proposedName,
        opts.file ? { targetFile: opts.file } : undefined,
      );
      console.log(result.message);

      if (result.candidates.length > 0) {
        console.log();
        for (const c of result.candidates) {
          const confidenceLabel =
            c.confidence === "high"
              ? pc.red(pc.bold(c.confidence))
              : c.confidence === "medium"
                ? pc.yellow(c.confidence)
                : pc.dim(c.confidence);
          const reasonLabel =
            c.matchReason === "exact_name"
              ? "exact name match"
              : c.matchReason === "similar_name"
                ? "similar name"
                : "similar purpose in this file";
          console.log(
            `  - ${pc.green(functionNameFromKey(c.key))} [${confidenceLabel} confidence — ${reasonLabel}] ${pc.dim(`${c.file}:${c.line}`)}`,
          );
        }
      }

      if (opts.record !== undefined) {
        if (result.candidates.length === 0) {
          console.log(
            pc.yellow(
              "\nNo similar functions found — nothing to record (a deliberate-duplicate decision requires a flagged match).",
            ),
          );
        } else {
          const fact = await recordKnownDuplicate(
            client,
            proposedName,
            opts.record,
            result.candidates,
          );
          console.log();
          console.log(pc.green(`Recorded deliberate-duplicate decision in memory: ${fact.key}`));
          console.log(pc.dim(`  ${fact.text}`));
        }
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
// test hook
// test hook 3
// test hook 4
// test hook 5
// test hook 6
// test hook 7
// final test
