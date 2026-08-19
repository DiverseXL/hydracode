#!/usr/bin/env node

import fs from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import fg from "fast-glob";
import { loadConfig } from "./config.js";
import { extractRepo, extractFile } from "./extract/tsExtractor.js";
import { runAskPipeline, describeKey, chainDisplay, resolveSymbol } from "./graph/askPipeline.js";
import type { AskResultNode, AskEvidencePath } from "./graph/askPipeline.js";
import { runInstall } from "./install.js";
import { getGraphStatus, getCallers, getCallees, getPathEvidence, MAX_HOPS } from "./graph/query.js";
import { NODE_LABELS, REL_TYPES } from "./graph/schema.js";
import { buildGraphSummary, renderAgentsMdSection, MARKER_START, MARKER_END } from "./graph/agentsSummary.js";
import { checkDuplicateRisk, functionNameFromKey } from "./graph/duplicateCheck.js";
import { recordKnownDuplicate, recordMemoryFactAbout, recallMemoryFacts, listMemoryFacts } from "./memory/store.js";
import { writeExtractedFiles } from "./graph/writer.js";
import { parseSarif } from "./extract/sarifParser.js";
import { writeFindings } from "./graph/sarifWriter.js";
import { buildVisualizationData, renderVisualizationHtml } from "./graph/visualize.js";
import { HydraClient } from "./hydra/client.js";
import { HydraConnectionError, HydraQueryError } from "./hydra/errors.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const BANNER = `  ██╗  ██╗██╗   ██╗██████╗ ██████╗  █████╗  ██████╗ ██████╗ ██████╗ ███████╗
  ██║  ██║╚██╗ ██╔╝██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝
  ███████║ ╚████╔╝ ██║  ██║██████╔╝███████║██║     ██║   ██║██║  ██║█████╗
  ██╔══██║  ╚██╔╝  ██║  ██║██╔══██╗██╔══██║██║     ██║   ██║██║  ██║██╔══╝
  ██║  ██║   ██║   ██████╔╝██║  ██║██║  ██║╚██████╗╚██████╔╝██████╔╝███████╗
  ╚═╝  ╚═╝   ╚═╝   ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝╚══════╝
  HydraDB-backed code graph for AI coding agents
  ${pc.dim(`v${version} · github.com/DiverseXL/hydracode · Hack Hydra 2026 · Track 02B`)}`;

const program = new Command();

program
  .name("hydracode")
  .description(
    "Index a codebase into a HydraDB graph for AI coding agents: multi-hop, relationship-aware context plus a temporal memory layer.",
  )
  .version(version);

program.addHelpText("beforeAll", `\n${pc.cyan(BANNER)}\n\n`);

program.addHelpText("after", `
${pc.dim("─────────────────────────────────────────────────")}
${pc.bold("Command reference")}

${pc.bold("Indexing")}
  ${pc.cyan("index [--path] [--watch] [--changed-only]")}    Index a codebase into HydraDB
  ${pc.cyan("status")}                                      Show graph counts
  ${pc.cyan("init-hooks")}                                  Install git post-commit hook
  ${pc.cyan("visualize [--output]")}                        Export graph as interactive HTML
  ${pc.cyan("import-sarif <file> [--tool]")}                Import SARIF security findings

${pc.bold("Querying")}
  ${pc.cyan("callers <symbol> [--max-hops]")}         Who calls this function (transitive)
  ${pc.cyan("callees <symbol> [--max-hops]")}         What this function calls (transitive)
  ${pc.cyan("impact <symbol> [--max-hops]")}          Full blast radius: callers + callees + paths
  ${pc.cyan("ask \"<question>\" [--max-hops]")}              Multi-hop ask with path evidence
  ${pc.cyan("check-duplicate \"<name>\" [--file] [--record]")} Pre-write duplicate detection

${pc.bold("Memory")}
  ${pc.cyan("memory record \"<text>\" [--about] [--supersedes]")}  Record a decision
  ${pc.cyan("memory recall [query] [--near] [--about]")}          Recall decisions
  ${pc.cyan("memory list [--all]")}                               Browse all facts

${pc.bold("Agents")}
  ${pc.cyan("mcp")}                                            Start MCP server on stdio
  ${pc.cyan("install")}                                        Auto-wire Cursor + Claude Code
  ${pc.cyan("sync-agents-md")}                                 Update AGENTS.md from graph
${pc.dim("─────────────────────────────────────────────────")}
Run ${pc.cyan("hydracode <command> --help")} for detailed options.
`);

// Print a slim version marker to stderr on every subcommand invocation.
// Excluded for the `mcp` command because its stdio transport owns stdout
// and anything else on stdout would corrupt the connection.
program.hook("preAction", (_thisCommand, actionCommand) => {
  if (process.argv[2] !== "mcp") {
    process.stderr.write(pc.dim(`hydracode v${version}\n`));
  }
});

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

    // Related decisions (memory facts about the anchor or its neighbors).
    const mem = result.relatedMemory;
    if (mem !== undefined && mem.length > 0) {
      console.log(pc.dim(`\nrelated decisions`));
      for (const f of mem) {
        const shortKey = f.key.replace("memory:", "").substring(0, 8);
        const dateStr = f.createdAt.split("T")[0];
        const aboutStr = f.about.length > 0 ? f.about.join(", ") : "";
        console.log(
          `  ${pc.green(`\u2022 memory:${shortKey}`)}  ${pc.dim(`"${f.text.substring(0, 60)}${f.text.length > 60 ? "\u2026" : ""}"`)}`,
        );
        if (aboutStr.length > 0) {
          console.log(pc.dim(`    about: ${aboutStr} \u00b7 recorded ${dateStr}`));
        } else {
          console.log(pc.dim(`    recorded ${dateStr}`));
        }
      }
    }

    // Security findings affecting the anchor node.
    const secFindings = result.securityFindings;
    if (secFindings !== undefined && secFindings.length > 0) {
      console.log(pc.dim(`\nsecurity findings (${secFindings.length})`));
      for (const f of secFindings) {
        const sevColor = f.severity === "error"
          ? pc.red
          : f.severity === "warning"
            ? pc.yellow
            : pc.dim;
        console.log(
          `  ${sevColor("\u26a0")} ${pc.bold(f.ruleId)} (${sevColor(f.severity)}) — ${pc.cyan(f.location)}`,
        );
        console.log(pc.dim(`    "${f.message}"`));
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
  .option("--supersedes <fact-key>", "optional: key of an older fact that this one replaces (mark old as superseded)")
  .action(async (text: string, opts: { about?: string; supersedes?: string }) => {
    try {
      const config = loadConfig();
      const client = new HydraClient(config);

      console.log(pc.bold("hydracode memory record"));
      console.log();

      const { recorded, superseded, about } = await recordMemoryFactAbout(
        client,
        text,
        opts.about,
        opts.supersedes,
      );
      console.log(pc.green(`✓ recorded`), pc.bold(recorded.key));
      console.log(pc.dim(`  ${recorded.text}`));
      console.log(pc.dim(`  createdAt: ${recorded.createdAt}`));
      if (about.length > 0) {
        console.log(pc.dim(`  about: ${about.map((a) => a.key).join(", ")}`));
      }
      if (superseded) {
        console.log();
        console.log(pc.green(`↳ supersedes`), pc.bold(superseded.key));
        console.log(pc.dim(`  ${superseded.text}`));
        console.log(pc.dim(`  (status updated to: superseded)`));
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
  .argument("[query]", "search text (ignored when --about or --near is given)")
  .option("--about <name>", "only recall facts linked to this function/class/file")
  .option("--near <name>", "recall facts about this node AND its file + 1-hop call neighborhood")
  .action(async (query: string, opts: { about?: string; near?: string }) => {
    try {
      const config = loadConfig();
      const client = new HydraClient(config);

      console.log(pc.bold("hydracode memory recall"));
      console.log();

      const facts = await recallMemoryFacts(client, { query, about: opts.about, nearNode: opts.near });
      if (facts.length === 0) {
        console.log(pc.dim("no matching facts found"));
      } else {
        if (opts.near) {
          // Render the proximity mode header — always show the anchor name
          console.log(pc.dim(`memory facts near ${pc.cyan(opts.near)} (file + 1-hop calls)`));
          console.log();
        }
        for (const f of facts) {
          const hopAnnotation = f.aboutAnchor === false ? pc.dim(" ← neighborhood") : "";
          const shortKey = f.key.replace("memory:", "").substring(0, 8);
          const dateStr = f.createdAt.split("T")[0];
          console.log(`  ${pc.green(`• memory:${shortKey}`)}  ${pc.dim(`"${f.text.substring(0, 60)}${f.text.length > 60 ? "…" : ""}"`)}${hopAnnotation}`);
          if (f.about.length > 0) {
            console.log(pc.dim(`    about: ${f.about.join(", ")}`));
          }
          console.log(pc.dim(`    recorded ${dateStr} · trust ${f.trust.toFixed(1)}`));
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

memoryCmd
  .command("list")
  .description("List all active memory facts, grouped by what they concern")
  .option("--all", "include superseded facts in a separate section")
  .action(async (opts: { all?: boolean }) => {
    try {
      const config = loadConfig();
      const client = new HydraClient(config);

      console.log(pc.bold("hydracode memory list"));
      console.log();

      const facts = await listMemoryFacts(client, { includeSuperseded: opts.all });
      if (facts.length === 0) {
        console.log(pc.dim("No memory facts recorded yet. Use `hydracode memory record` to add one."));
        return;
      }

      // Group facts by status and then by ABOUT target
      const activeFacts = facts.filter((f) => f.status === "active");
      const supersededFacts = facts.filter((f) => f.status === "superseded");

      // Group active facts by ABOUT target
      const byAbout = new Map<string, typeof activeFacts>();
      const unlinked: typeof activeFacts = [];

      for (const f of activeFacts) {
        if (f.about.length === 0) {
          unlinked.push(f);
        } else {
          for (const target of f.about) {
            if (!byAbout.has(target)) byAbout.set(target, []);
            byAbout.get(target)!.push(f);
          }
        }
      }

      console.log(pc.dim(`Active memory facts (${activeFacts.length})`));
      console.log();

      // Sort and render ABOUT-linked facts
      const sortedTargets = Array.from(byAbout.keys()).sort();
      for (const target of sortedTargets) {
        console.log(pc.dim(`── linked to ${target} ──`));
        for (const f of byAbout.get(target)!) {
          const shortKey = f.key.replace("memory:", "").substring(0, 8);
          const dateStr = f.createdAt.split("T")[0];
          console.log(
            `${pc.green(`• memory:${shortKey}`)}  ${pc.dim(`"${f.text.substring(0, 50)}${f.text.length > 50 ? "…" : ""}"`)}`
          );
          console.log(
            pc.dim(`  recorded ${dateStr} · trust ${f.trust.toFixed(1)}`),
          );
        }
        console.log();
      }

      // Render unlinked facts
      if (unlinked.length > 0) {
        console.log(pc.dim("── unlinked ──"));
        for (const f of unlinked) {
          const shortKey = f.key.replace("memory:", "").substring(0, 8);
          const dateStr = f.createdAt.split("T")[0];
          console.log(
            `${pc.green(`• memory:${shortKey}`)}  ${pc.dim(`"${f.text.substring(0, 50)}${f.text.length > 50 ? "…" : ""}"`)}`
          );
          console.log(
            pc.dim(`  recorded ${dateStr} · trust ${f.trust.toFixed(1)}`),
          );
        }
        console.log();
      }

      // Render superseded facts if --all
      if (opts.all && supersededFacts.length > 0) {
        console.log(pc.dim("── superseded ──"));
        for (const f of supersededFacts) {
          const shortKey = f.key.replace("memory:", "").substring(0, 8);
          const dateStr = f.createdAt.split("T")[0];
          const supersedesRef = f.supersededBy ? ` ${pc.dim(`[superseded by memory:${f.supersededBy.replace("memory:", "").substring(0, 8)}]`)}` : "";
          console.log(
            `${pc.dim(`• memory:${shortKey}`)}  ${pc.dim(`"${f.text.substring(0, 50)}${f.text.length > 50 ? "…" : ""}"${supersedesRef}`)}`
          );
          console.log(
            pc.dim(`  recorded ${dateStr} · trust ${f.trust.toFixed(1)}`),
          );
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
  .command("visualize")
  .description("Export the indexed code graph as an interactive HTML visualization")
  .option("--output <path>", "output file path (default: hydracode-graph.html)", "hydracode-graph.html")
  .action(async (opts: { output: string }) => {
    try {
      const config = loadConfig();
      const client = new HydraClient(config);

      console.log(pc.bold("hydracode visualize"));
      console.log();

      const data = await buildVisualizationData(client);
      if (data.nodes.length === 0) {
        console.log(pc.yellow("Graph is empty — run `hydracode index` first to populate it."));
        return;
      }

      const html = renderVisualizationHtml(data);
      const outPath = path.resolve(opts.output);
      fs.writeFileSync(outPath, html, "utf8");

      console.log(pc.green(`\u2713 graph exported to ${opts.output}`));
      console.log(pc.dim(`  ${data.meta.totalFunctions} functions \u00b7 ${data.meta.totalFiles} files \u00b7 ${data.meta.totalClasses} classes \u00b7 ${data.edges.length} edges`));
      console.log(pc.dim("  Open in any browser \u2014 no server needed."));
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

program
  .command("callers")
  .description("Find all functions that call a given function (transitive)")
  .argument("<symbol>", "function name to look up")
  .option("--max-hops <n>", "max traversal depth (clamped to 3)", "3")
  .option("--json", "output raw JSON instead of formatted text")
  .action(async (symbol: string, opts: { maxHops: string; json: boolean }) => {
    const client = new HydraClient(loadConfig());
    const maxHops = Math.min(Math.max(1, Number(opts.maxHops) || MAX_HOPS), MAX_HOPS);

    const resolved = await resolveSymbol(client, symbol);
    if (!resolved.resolved) {
      console.log(pc.red(resolved.message));
      if (resolved.ambiguous && resolved.candidates) {
        for (let i = 0; i < resolved.candidates.length; i++) {
          console.log(`  ${i + 1}. ${resolved.candidates[i].label}`);
        }
      }
      process.exitCode = 1;
      return;
    }

    const callers = await getCallers(client, resolved.node.id, maxHops);
    const results: AskResultNode[] = callers.map((c) => ({
      key: c.key,
      display: describeKey(c.key),
      file: c.key.replace(/^(file|module|function|class|test|memory):/, "").split("#")[0] ?? c.key,
      line: (() => {
        const parts = c.key.replace(/^(file|module|function|class|test|memory):/, "").split("#");
        const last = parts[parts.length - 1];
        return parts.length >= 3 && last !== undefined && /^\d+$/.test(last) ? parseInt(last, 10) : undefined;
      })(),
    }));

    if (opts.json) {
      console.log(JSON.stringify({
        resolved: true,
        symbol,
        callers: results.map((r) => ({ key: r.key, file: r.file, line: r.line })),
        message: `found ${results.length} caller(s) of ${describeKey(resolved.node.key)}`,
      }, null, 2));
      return;
    }

    console.log(pc.bold(`\ncallers of ${pc.cyan(describeKey(resolved.node.key))}`));
    if (results.length === 0) {
      console.log(pc.dim("  (no callers found)"));
    } else {
      console.log(`  ${pc.bold("callers")} (${results.length}):`);
      for (const r of results) {
        console.log(`    ${pc.green(r.display)}`);
      }
    }
  });

program
  .command("callees")
  .description("Find all functions that a given function calls (transitive)")
  .argument("<symbol>", "function name to look up")
  .option("--max-hops <n>", "max traversal depth (clamped to 3)", "3")
  .option("--json", "output raw JSON instead of formatted text")
  .action(async (symbol: string, opts: { maxHops: string; json: boolean }) => {
    const client = new HydraClient(loadConfig());
    const maxHops = Math.min(Math.max(1, Number(opts.maxHops) || MAX_HOPS), MAX_HOPS);

    const resolved = await resolveSymbol(client, symbol);
    if (!resolved.resolved) {
      console.log(pc.red(resolved.message));
      if (resolved.ambiguous && resolved.candidates) {
        for (let i = 0; i < resolved.candidates.length; i++) {
          console.log(`  ${i + 1}. ${resolved.candidates[i].label}`);
        }
      }
      process.exitCode = 1;
      return;
    }

    const callees = await getCallees(client, resolved.node.id, maxHops);
    const results: AskResultNode[] = callees.map((c) => ({
      key: c.key,
      display: describeKey(c.key),
      file: c.key.replace(/^(file|module|function|class|test|memory):/, "").split("#")[0] ?? c.key,
      line: (() => {
        const parts = c.key.replace(/^(file|module|function|class|test|memory):/, "").split("#");
        const last = parts[parts.length - 1];
        return parts.length >= 3 && last !== undefined && /^\d+$/.test(last) ? parseInt(last, 10) : undefined;
      })(),
    }));

    if (opts.json) {
      console.log(JSON.stringify({
        resolved: true,
        symbol,
        callees: results.map((r) => ({ key: r.key, file: r.file, line: r.line })),
        message: `found ${results.length} callee(s) of ${describeKey(resolved.node.key)}`,
      }, null, 2));
      return;
    }

    console.log(pc.bold(`\ncallees of ${pc.cyan(describeKey(resolved.node.key))}`));
    if (results.length === 0) {
      console.log(pc.dim("  (no callees found)"));
    } else {
      console.log(`  ${pc.bold("callees")} (${results.length}):`);
      for (const r of results) {
        console.log(`    ${pc.green(r.display)}`);
      }
    }
  });

program
  .command("impact")
  .description("Full blast radius: callers + callees + call-chain paths")
  .argument("<symbol>", "function name to assess")
  .option("--max-hops <n>", "max traversal depth (clamped to 3)", "3")
  .option("--json", "output raw JSON instead of formatted text")
  .action(async (symbol: string, opts: { maxHops: string; json: boolean }) => {
    const client = new HydraClient(loadConfig());
    const maxHops = Math.min(Math.max(1, Number(opts.maxHops) || MAX_HOPS), MAX_HOPS);

    const resolved = await resolveSymbol(client, symbol);
    if (!resolved.resolved) {
      console.log(pc.red(resolved.message));
      if (resolved.ambiguous && resolved.candidates) {
        for (let i = 0; i < resolved.candidates.length; i++) {
          console.log(`  ${i + 1}. ${resolved.candidates[i].label}`);
        }
      }
      process.exitCode = 1;
      return;
    }

    const [callers, callees, rawPaths] = await Promise.all([
      getCallers(client, resolved.node.id, maxHops),
      getCallees(client, resolved.node.id, maxHops),
      getPathEvidence(client, resolved.node.id, {
        relTypes: ["CALLS" as const],
        maxLen: maxHops,
        pathCount: 10,
      }),
    ]);

    const callerResults = callers.map((c) => ({ key: c.key, file: c.key.replace(/^(file|module|function|class|test|memory):/, "").split("#")[0] ?? c.key, line: (() => { const parts = c.key.replace(/^(file|module|function|class|test|memory):/, "").split("#"); const last = parts[parts.length - 1]; return parts.length >= 3 && last !== undefined && /^\d+$/.test(last) ? parseInt(last, 10) : undefined; })() }));
    const calleeResults = callees.map((c) => ({ key: c.key, file: c.key.replace(/^(file|module|function|class|test|memory):/, "").split("#")[0] ?? c.key, line: (() => { const parts = c.key.replace(/^(file|module|function|class|test|memory):/, "").split("#"); const last = parts[parts.length - 1]; return parts.length >= 3 && last !== undefined && /^\d+$/.test(last) ? parseInt(last, 10) : undefined; })() }));
    const evidence = rawPaths
      .filter((p) => p.parseSucceeded)
      .slice(0, 10)
      .map((p) => ({
        pathText: (() => {
          const labels = p.nodes.map((n) => {
            const bare = n.key.replace(/^(file|module|function|class|test|memory):/, "");
            if (n.key.startsWith("function:") || n.key.startsWith("test:")) {
              const parts = bare.split("#");
              if (parts.length >= 3) return parts[parts.length - 2] ?? bare;
            }
            return bare;
          });
          if (p.rels && p.rels.length === p.nodes.length - 1) {
            let text = `[${labels[0]}]`;
            for (let i = 0; i < p.rels.length; i++) {
              text += ` -[:${p.rels[i]}]-> [${labels[i + 1]}]`;
            }
            return text;
          }
          return labels.join(" → ");
        })(),
        weight: p.weight,
      }));

    if (opts.json) {
      console.log(JSON.stringify({
        resolved: true,
        symbol,
        callers: callerResults,
        callees: calleeResults,
        evidence,
        message: `impact of ${describeKey(resolved.node.key)}: ${callerResults.length} callers, ${calleeResults.length} callees, ${evidence.length} paths`,
      }, null, 2));
      return;
    }

    const anchorLabel = describeKey(resolved.node.key);
    console.log(pc.bold(`\nimpact of ${pc.cyan(anchorLabel)}`));
    console.log();

    // CALLERS section
    console.log(pc.bold(`CALLERS (${callerResults.length})`) + pc.dim(" — things that break if you change the signature"));
    if (callerResults.length === 0) {
      console.log(pc.dim("  (none)"));
    } else {
      for (const r of callerResults) {
        const display = describeKey(r.key);
        console.log(`  ${pc.green(display)}`);
      }
    }
    console.log();

    // CALLEES section
    console.log(pc.bold(`CALLEES (${calleeResults.length})`) + pc.dim(" — things this function breaks if they change"));
    if (calleeResults.length === 0) {
      console.log(pc.dim("  (none)"));
    } else {
      for (const r of calleeResults) {
        const display = describeKey(r.key);
        console.log(`  ${pc.green(display)}`);
      }
    }
    console.log();

    // CALL PATHS section
    console.log(pc.bold(`CALL PATHS (${evidence.length})`) + pc.dim(" — actual chain evidence"));
    if (evidence.length === 0) {
      console.log(pc.dim("  (no paths found)"));
    } else {
      for (const p of evidence) {
        const rendered = p.pathText.includes(" -[")
          ? p.pathText
              .replace(/\[([^\]]+)\]/g, (_m: string, name: string) => pc.green(`[${name}]`))
              .replace(/( -\[:[^\]]+\]-> )/g, (_m: string, sep: string) => pc.dim(sep))
          : p.pathText
              .split(" \u2192 ")
              .map((seg: string) => pc.green(seg))
              .join(pc.dim(" \u2192 "));
        console.log(
          `  ${rendered}${p.weight !== undefined ? pc.dim(`  (weight ${p.weight})`) : ""}`,
        );
      }
    }

    // SECURITY FINDINGS section
    try {
      const secRes = await client.query(
        `MATCH (s:${NODE_LABELS.SECURITY_FINDING})-[:${REL_TYPES.AFFECTS}]->(n {id: $anchorId})
         RETURN s.key AS key, s.ruleId AS ruleId, s.message AS message,
                s.severity AS severity, s.uri AS uri, s.startLine AS startLine
         LIMIT 5`,
        { anchorId: resolved.node.id },
        { consistency: "strong" },
      );
      if (secRes.rows.length > 0) {
        console.log(pc.bold(`SECURITY FINDINGS (${secRes.rows.length})`));
        for (const row of secRes.rows) {
          const cells = row as unknown[];
          const ruleId = unwrapCli(cells[1]);
          const message = unwrapCli(cells[2]);
          const severity = unwrapCli(cells[3]);
          const uri = unwrapCli(cells[4]);
          const startLine = unwrapCli(cells[5]);
          const sevColor = severity === "error" ? pc.red : severity === "warning" ? pc.yellow : pc.dim;
          console.log(`  ${sevColor("\u26a0")} ${pc.bold(ruleId)} (${sevColor(severity)}) — ${pc.cyan(`${uri}:${startLine}`)}`);
          console.log(pc.dim(`    "${message}"`));
        }
      }
    } catch {
      // Security enrichment is best-effort for impact too.
    }

    // RELATED DECISIONS section
    try {
      const nearName = resolved.node.name ?? describeKey(resolved.node.key).split(":")[0];
      if (nearName && nearName.length > 0) {
        const memFacts = await recallMemoryFacts(client, { nearNode: nearName, query: "" });
        if (memFacts.length > 0) {
          const sorted = memFacts.sort((a, b) => b.trust - a.trust || b.createdAt.localeCompare(a.createdAt)).slice(0, 3);
          console.log(pc.dim("\nrelated decisions"));
          for (const f of sorted) {
            const shortKey = f.key.replace("memory:", "").substring(0, 8);
            const dateStr = f.createdAt.split("T")[0];
            console.log(`  ${pc.green(`\u2022 memory:${shortKey}`)}  ${pc.dim(`"${f.text.substring(0, 60)}${f.text.length > 60 ? "\u2026" : ""}"`)}`);
            if (f.about.length > 0) {
              console.log(pc.dim(`    about: ${f.about.join(", ")} \u00b7 recorded ${dateStr}`));
            } else {
              console.log(pc.dim(`    recorded ${dateStr}`));
            }
          }
        }
      }
    } catch {
      // Memory enrichment is best-effort.
    }
  });

/** Unwrap a HydraDB row cell value for CLI rendering. */
function unwrapCli(v: unknown): string {
  if (v === null || typeof v !== "object") return String(v ?? "");
  const record = v as Record<string, unknown>;
  if (typeof record.type === "string" && "value" in record) return String(record.value ?? "");
  return String(v);
}

program
  .command("import-sarif")
  .description("Import SARIF security analysis results into the code graph")
  .argument("<file>", "path to a SARIF JSON file")
  .option("--tool <name>", "override tool name from SARIF")
  .action(async (file: string, opts: { tool?: string }) => {
    try {
      const config = loadConfig();
      const client = new HydraClient(config);

      console.log(pc.bold("hydracode import-sarif"));
      console.log();

      // Read and parse the SARIF file.
      const absPath = path.resolve(file);
      if (!fs.existsSync(absPath)) {
        console.error(pc.red(`error: file not found: ${absPath}`));
        process.exitCode = 1;
        return;
      }

      let sarifJson: unknown;
      try {
        const content = fs.readFileSync(absPath, "utf8");
        sarifJson = JSON.parse(content);
      } catch (err) {
        console.error(pc.red(`error: failed to parse SARIF file: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
        return;
      }

      const repoRoot = process.cwd();
      let findings = parseSarif(sarifJson, repoRoot);

      // Override tool name if --tool is provided.
      if (opts.tool) {
        findings = findings.map((f) => ({ ...f, tool: opts.tool! }));
      }

      if (findings.length === 0) {
        console.log(pc.yellow("no findings found in SARIF file"));
        return;
      }

      // Check if graph is indexed.
      const { getGraphStatus } = await import("./graph/query.js");
      const status = await getGraphStatus(client);
      if (!status.indexed) {
        console.log(pc.yellow("warning: no indexed files found — run `hydracode index` first, AFFECTS edges to functions/files will be empty"));
      }

      const summary = await writeFindings(findings, client, { quiet: true });

      console.log(pc.green(`\n\u2713 imported ${summary.findingsWritten} findings from ${findings[0]?.tool ?? opts.tool ?? "unknown"}`));
      console.log(pc.dim(`  ${summary.affectsFunctionEdges} linked to functions · ${summary.affectsFileEdges} linked to files · ${summary.skippedNoLocation} skipped`));
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
