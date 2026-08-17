/**
 * src/install.ts
 *
 * `hydracode install` — write/update MCP server entries for Cursor and
 * Claude Code so a coding agent picks up hydracode automatically, no manual
 * JSON editing.
 *
 * Config locations/schemas verified against the CURRENT official docs
 * (Aug 2026):
 *   - Cursor: project config `.cursor/mcp.json`, global `~/.cursor/mcp.json`
 *     (https://cursor.com/docs/mcp — "Configuration locations"). Stdio
 *     entries are `mcpServers` -> { type: "stdio", command, args } per the
 *     docs' STDIO server configuration table.
 *   - Claude Code: project scope `.mcp.json` in the project root
 *     (https://code.claude.com/docs/en/mcp — `claude mcp add --scope project`
 *     writes this file; it is the recommended committed file). User scope is
 *     `~/.claude.json` under the top-level `mcpServers` key. A stdio entry
 *     carries NO `type` field — Claude Code reads an entry without `type` as
 *     stdio (the docs explicitly document that a `url` without `type` is the
 *     error case, and type is only for http/sse/ws).
 *
 * Non-destructive philosophy: merge into existing `mcpServers` objects,
 * never overwrite other servers, never rewrite a config whose JSON doesn't
 * parse. The hydracode entry is replaced in place when it already exists
 * (a re-run after `npm run build` should update the path, not duplicate).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

/** Tool names — kept as plain strings for user-facing labels. */
type ToolName = "Cursor" | "Claude Code";

interface McpTarget {
  tool: ToolName;
  scope: "project" | "user";
  /** Absolute path to the config file (may or may not exist yet). */
  file: string;
}

/** Absolute path to THIS project's built MCP entrypoint (dist/cli.js). */
export function builtCliPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/install.ts (tsx/dev) or dist/install.js (built) — project root is one up.
  const root = path.resolve(here, "..");
  return path.join(root, "dist", "cli.js");
}

/** Home dir — honour $HOME (Git Bash etc.) then fall back to os.homedir(). */
function homeDir(): string {
  return process.env.HOME && process.env.HOME.length > 0
    ? process.env.HOME
    : os.homedir();
}

/** The four candidate config locations, project-level first. */
function candidateTargets(): McpTarget[] {
  const home = homeDir();
  const cwd = process.cwd();
  return [
    { tool: "Cursor", scope: "project", file: path.join(cwd, ".cursor", "mcp.json") },
    { tool: "Claude Code", scope: "project", file: path.join(cwd, ".mcp.json") },
    { tool: "Cursor", scope: "user", file: path.join(home, ".cursor", "mcp.json") },
    { tool: "Claude Code", scope: "user", file: path.join(home, ".claude.json") },
  ];
}

/**
 * A tiny line reader over raw stdin 'data' events (see runInstall for why
 * node:readline is avoided). Buffers partial lines across chunks and keeps
 * unconsumed lines for the next prompt, so multi-prompt flows work with
 * piped input (e.g. `printf 'y\ny\n' | hydracode install`).
 */
function createLineReader(): { nextLine(): Promise<string> } {
  let buffer = "";
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let ended = false;

  process.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.search(/\r?\n/)) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (waiters.length > 0) waiters.shift()!(line);
      else lines.push(line);
    }
  });
  process.stdin.on("end", () => {
    ended = true;
    if (buffer.length > 0) {
      if (waiters.length > 0) waiters.shift()!(buffer);
      else lines.push(buffer);
      buffer = "";
    }
    while (waiters.length > 0) waiters.shift()!("");
  });
  process.stdin.resume();

  return {
    nextLine(): Promise<string> {
      if (lines.length > 0) return Promise.resolve(lines.shift()!);
      if (ended) return Promise.resolve("");
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/** The mcpServers entry written for hydracode. */
function hydracodeEntry(cliPath: string): Record<string, unknown> {
  // Cursor's docs (STDIO config table) list `type: "stdio"`; Claude Code
  // must NOT receive it (no-type means stdio there). Tool-specific entry
  // shapes are applied per-target in writeTarget.
  return {
    command: "node",
    args: [cliPath, "mcp"],
  };
}

/** Read + parse a JSON config file; undefined when absent, throws on bad JSON. */
function readConfig(file: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) return undefined;
  const raw = fs.readFileSync(file, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`top level of ${file} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Merge the hydracode entry into one target's config file. Returns a
 * description of what happened for the summary.
 */
function writeTarget(target: McpTarget, cliPath: string): "created" | "updated" {
  const existing = readConfig(target.file);
  const entry = hydracodeEntry(cliPath);
  // Cursor's STDIO schema documents `type: "stdio"`; Claude Code reads a
  // bare command entry as stdio and has no `type` field for it — applied
  // BEFORE the branch so a fresh create carries it too.
  if (target.tool === "Cursor") {
    entry.type = "stdio";
  }

  let config: Record<string, unknown>;
  if (existing === undefined) {
    config = { mcpServers: { hydracode: entry } };
  } else {
    const servers = existing.mcpServers;
    if (
      servers !== undefined &&
      (servers === null || typeof servers !== "object" || Array.isArray(servers))
    ) {
      throw new Error(`"mcpServers" in ${target.file} is not a JSON object`);
    }
    const serversObj = (servers as Record<string, unknown> | undefined) ?? {};
    const already = Object.prototype.hasOwnProperty.call(serversObj, "hydracode");
    serversObj.hydracode = entry;
    config = { ...existing, mcpServers: serversObj };
    if (already) {
      fs.mkdirSync(path.dirname(target.file), { recursive: true });
      fs.writeFileSync(target.file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      return "updated";
    }
  }

  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return "created";
}

/**
 * The `hydracode install` entry point (called by cli.ts).
 *
 * Prompts once per candidate target: update when the config file exists,
 * create for the project-level files when absent. User-level targets are
 * only offered when their config already exists (a tool with no user config
 * present is not "found").
 */
export async function runInstall(): Promise<void> {
  const cliPath = builtCliPath();
  console.log(pc.bold("hydracode install"));
  console.log();

  if (!fs.existsSync(cliPath)) {
    console.log(
      pc.yellow(
        `dist/cli.js not found at ${cliPath} — the project isn't built yet. ` +
          `Run \`npm run build\` first, then re-run \`hydracode install\` so the ` +
          `MCP entry points at a real executable.`,
      ),
    );
    console.log(pc.dim("(no config files were written)"));
    return;
  }

  console.log(pc.dim(`MCP entry will run: node ${cliPath} mcp`));
  console.log();

  // Deliberately NOT node:readline: `rl.question()` fires only ONCE on a
  // piped stdin (a Node bug — the second call never resolves and the
  // process exits 0). A tiny line reader over raw 'data' events is
  // deterministic for pipes AND canonical-mode TTYs.
  const reader = createLineReader();
  const ask = async (question: string): Promise<boolean> => {
    process.stderr.write(`${question} ${pc.dim("[y/N]")} `);
    const answer = await reader.nextLine();
    return /^y(?:es)?$/i.test(answer.trim());
  };

  const results: { target: McpTarget; action: string }[] = [];
  for (const target of candidateTargets()) {
    const exists = fs.existsSync(target.file);
    if (!exists && target.scope === "user") {
      // Not "present" anywhere — don't scaffold a whole user config dir.
      results.push({ target, action: "skipped" });
      continue;
    }

    const question = exists
      ? `Update the hydracode MCP entry in ${pc.cyan(target.file)}?`
      : `Create MCP config for ${target.tool} at ${pc.cyan(target.file)}?`;
    if (!(await ask(question))) {
      results.push({ target, action: "skipped" });
      continue;
    }

    try {
      const action = writeTarget(target, cliPath);
      results.push({ target, action });
    } catch (err) {
      console.log(
        pc.red(
          `  error: could not write ${target.file} — ${err instanceof Error ? err.message : String(err)}. Skipping (your existing config was not modified).`,
        ),
      );
      results.push({ target, action: "failed" });
    }
  }

  console.log();
  console.log(pc.bold("Summary:"));
  for (const { target, action } of results) {
    const label =
      action === "created"
        ? pc.green("created")
        : action === "updated"
          ? pc.green("updated")
          : action === "failed"
            ? pc.red("failed")
            : pc.dim("skipped");
    console.log(`  ${label} ${target.tool} (${target.scope}): ${pc.dim(target.file)}`);
  }
  console.log();
  console.log(
    pc.dim(
      "Restart the target tool (or reload its MCP config) for the hydracode server to be picked up. " +
        "Claude Code project-scoped servers need approval on first use (`claude` in the project).",
    ),
  );
}
