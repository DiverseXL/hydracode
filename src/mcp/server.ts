/**
 * HydraCode MCP server — exposes indexing and query capabilities as Model
 * Context Protocol tools so any MCP-aware coding agent (Claude Code, Cursor,
 * etc.) can call into the code graph automatically during normal use.
 *
 * Transport: STDIO (StdioServerTransport). MCP clients launch this as a
 * subprocess; the protocol travels over stdin/stdout. This is critical:
 *   - NOTHING may write to stdout other than the MCP protocol frames.
 *   - console.log / ora / any other stdout write will corrupt the stream
 *     and silently break the connection from the client's perspective.
 *   - All diagnostic output goes to stderr (console.error is safe).
 *   - ora spinners default to stderr and are passed quiet:true anyway
 *     (belt-and-suspenders — see hydracode_index handler).
 *
 * Startup resilience: loadConfig() and HydraClient construction happen
 * inside a try/catch at module initialisation. A bad config does NOT crash
 * the process — the server starts, connects, and every tool call returns a
 * structured config-error response instead. This ensures an agent always
 * gets an actionable error message rather than seeing a dead subprocess.
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { extractRepo } from "../extract/tsExtractor.js";
import { runAskPipeline } from "../graph/askPipeline.js";
import { checkDuplicateRisk } from "../graph/duplicateCheck.js";
import { getGraphStatus } from "../graph/query.js";
import {
  recallMemoryFacts,
  recordKnownDuplicate,
  recordMemoryFactAbout,
  listMemoryFacts,
} from "../memory/store.js";
import { writeExtractedFiles } from "../graph/writer.js";
import { HydraClient } from "../hydra/client.js";

/* ------------------------------------------------------------------ */
/* Version                                                              */
/* ------------------------------------------------------------------ */

// Read version from package.json so it stays in sync automatically.
// Using createRequire because this file compiles to ESM (type: "module").
const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

/* ------------------------------------------------------------------ */
/* Config / client — resilient startup                                  */
/* ------------------------------------------------------------------ */

/**
 * Attempt config load + client construction once at startup. On failure,
 * store the error message. Every tool handler checks this before running;
 * if it is set, the tool returns a structured config-error response instead
 * of crashing or hanging. The SERVER PROCESS STAYS ALIVE regardless.
 */
let client: HydraClient | undefined;
let configError: string | undefined;

try {
  const config = loadConfig();
  client = new HydraClient(config);
} catch (err) {
  configError =
    err instanceof Error ? err.message : String(err);
  // Log to stderr only — never stdout, which is reserved for MCP protocol.
  process.stderr.write(
    `[hydracode-mcp] config error (tools will return error responses): ${configError}\n`,
  );
}

/* ------------------------------------------------------------------ */
/* MCP server                                                           */
/* ------------------------------------------------------------------ */

const server = new McpServer({ name: "hydracode", version });

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/** Uniform config-error content block for all tool handlers. */
function configErrorContent(): { content: [{ type: "text"; text: string }] } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: "config",
          message:
            configError ??
            "HydraCode config missing. Set HYDRACODE_HYDRADB_TOKEN (and optionally HYDRACODE_HYDRADB_URI) in your MCP client's env config, or add a .hydracode/config.json file to your project.",
          hint: "Run `hydracode init` or see the README for setup instructions.",
        }),
      },
    ],
  };
}

/** Wrap any async tool handler so uncaught exceptions return a structured error. */
async function safeCall(
  fn: () => Promise<{ content: [{ type: "text"; text: string }] }>,
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "tool_error", message }),
        },
      ],
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tool: hydracode_ask                                                  */
/* ------------------------------------------------------------------ */

// Note: server.tool() is the deprecated-but-functional overload; registerTool()
// is the preferred API going forward. Both accept a Zod shape for input schema
// validation. Migrate to registerTool() in a future cleanup pass.
server.tool(
  "hydracode_ask",
  "Query the indexed code graph for this repository to find real call relationships, " +
    "containment, and structure. Use this instead of guessing from code similarity when " +
    "you need to know what calls a function, what a function calls, or how two pieces of " +
    "code are actually connected. Returns evidence (actual call paths), not just a list. " +
    "Run hydracode_index first if the repository hasn't been indexed yet.",
  {
    question: z
      .string()
      .describe(
        'Natural-language question about the codebase, e.g. "who calls writeExtractedFiles" or "what does HydraClient.query call".',
      ),
    maxHops: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(3)
      .optional()
      .describe("Maximum traversal depth (1-3, default 3)."),
  },
  async ({ question, maxHops }) => {
    if (configError || !client) return configErrorContent();
    return safeCall(async () => {
      const result = await runAskPipeline(client!, question, maxHops ?? 3);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    });
  },
);

/* ------------------------------------------------------------------ */
/* Tool: hydracode_index                                                */
/* ------------------------------------------------------------------ */

server.tool(
  "hydracode_index",
  "Index (or re-index) a codebase into the HydraDB-backed code graph, so hydracode_ask " +
    "has current data to query. Safe to re-run — updates changed code and removes stale " +
    "entries automatically. Should be run once before first use, and again after significant " +
    "code changes if the agent needs up-to-date graph context.",
  {
    path: z
      .string()
      .default(".")
      .optional()
      .describe('Root directory to index (default: current working directory ".").'),
    patterns: z
      .array(z.string())
      .optional()
      .describe(
        'Glob patterns to include (default: ["**/*.{ts,tsx,js,jsx}"]).',
      ),
  },
  async ({ path: dirPath, patterns }) => {
    if (configError || !client) return configErrorContent();
    return safeCall(async () => {
      // quiet:true is non-negotiable here: even though ora defaults to stderr,
      // spinner \r animation frames are noise for a subprocess with no terminal.
      // Belt-and-suspenders — costs nothing and keeps the MCP subprocess clean.
      const files = await extractRepo(dirPath ?? ".", patterns, { quiet: true });
      const summary = await writeExtractedFiles(files, client!, { quiet: true });
      return {
        content: [{ type: "text", text: JSON.stringify(summary) }],
      };
    });
  },
);

/* ------------------------------------------------------------------ */
/* Tool: hydracode_status                                               */
/* ------------------------------------------------------------------ */

server.tool(
  "hydracode_status",
  "Check whether this repository has been indexed and get basic graph statistics " +
    "(function/class/file counts) without running a full query. Use this to confirm " +
    "the graph is populated before running hydracode_ask.",
  {},
  async () => {
    if (configError || !client) return configErrorContent();
    return safeCall(async () => {
      const status = await getGraphStatus(client!);
      return {
        content: [{ type: "text", text: JSON.stringify(status) }],
      };
    });
  },
);

/* ------------------------------------------------------------------ */
/* Tool: hydracode_check_duplicate                                     */
/* ------------------------------------------------------------------ */

server.tool(
  "hydracode_check_duplicate",
  "Check whether a function you're about to write might already exist in this codebase " +
    "under a different name, or something very similar. ALWAYS call this before implementing " +
    "a new function or utility, to avoid creating duplicate logic. Returns matching candidates " +
    "with file locations if anything similar is found, or confirms it's safe to proceed if " +
    "nothing matches. If you decide to write the function anyway despite the matches, pass " +
    "recordReason to record a deliberate-duplicate decision in the memory layer.",
  {
    proposedName: z
      .string()
      .describe("The name of the function you are about to write."),
    targetFile: z
      .string()
      .optional()
      .describe(
        "Optional: repo-relative path of the file the new function would live in, to also " +
          "catch same-file near-duplicates (e.g. src/db/users.ts).",
      ),
    recordReason: z
      .string()
      .optional()
      .describe(
        "Optional: if you are intentionally writing the new function anyway despite the " +
          "flagged matches, pass the reason — hydracode records a deliberate-duplicate " +
          "decision in the memory layer so future checks know the duplication was intentional.",
      ),
  },
  async ({ proposedName, targetFile, recordReason }) => {
    if (configError || !client) return configErrorContent();
    return safeCall(async () => {
      const result = await checkDuplicateRisk(
        client!,
        proposedName,
        targetFile !== undefined ? { targetFile } : undefined,
      );
      if (
        recordReason !== undefined &&
        result.candidates.length > 0
      ) {
        const recorded = await recordKnownDuplicate(
          client!,
          proposedName,
          recordReason,
          result.candidates,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...result, recorded }),
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    });
  },
);

/* ------------------------------------------------------------------ */
/* Tool: hydracode_record_decision                                     */
/* ------------------------------------------------------------------ */

server.tool(
  "hydracode_record_decision",
  "Record a project decision, convention, or rationale so future sessions (yours or " +
    "another agent's) can recall why something was done a certain way. Use this after " +
    "making a non-obvious choice — e.g. picking one approach over another, or deciding " +
    "not to fix something yet. Optionally pass supersedesKey to explicitly mark an older " +
    "decision as replaced by this one — the old fact is marked superseded and will no " +
    "longer appear in normal memory recall.",
  {
    text: z
      .string()
      .describe("The decision, convention, or rationale to record."),
    about: z
      .string()
      .optional()
      .describe(
        "Optional: name of a function, class, or file to link this fact to via an ABOUT edge " +
          "(resolved against the indexed graph; use the exact qualified name or file path).",
      ),
    supersedesKey: z
      .string()
      .optional()
      .describe(
        "Optional: key of an older MemoryFact that this one replaces. Can be the full " +
          "UUID form (memory:...) or just the UUID portion. The old fact is marked superseded " +
          "and will no longer appear in normal memory recall.",
      ),
  },
  async ({ text, about, supersedesKey }) => {
    if (configError || !client) return configErrorContent();
    return safeCall(async () => {
      const { recorded, superseded } = await recordMemoryFactAbout(
        client!,
        text,
        about,
        supersedesKey,
      );
      const response: Record<string, unknown> = { recorded };
      if (superseded) {
        response.superseded = superseded;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    });
  },
);

/* ------------------------------------------------------------------ */
/* Tool: hydracode_recall_memory                                       */
/* ------------------------------------------------------------------ */

server.tool(
  "hydracode_recall_memory",
  "Recall past decisions or conventions recorded for this project. Use this before " +
    "making an architectural choice, to check whether the team already decided something " +
    "relevant. Pass `about` to get facts linked to a specific function/class/file, or " +
    "`query` for a text match against recorded facts.",
  {
    query: z
      .string()
      .describe(
        "Search text matched against recorded fact text (ignored when `about` is given).",
      ),
    about: z
      .string()
      .optional()
      .describe(
        "Optional: only return facts linked via ABOUT to this function/class/file name.",
      ),
  },
  async ({ query, about }) => {
    if (configError || !client) return configErrorContent();
    return safeCall(async () => {
      const facts = await recallMemoryFacts(client!, { query, about });
      return {
        content: [{ type: "text", text: JSON.stringify({ facts }) }],
      };
    });
  },
);

server.tool(
  "hydracode_list_memory",
  "List all active memory facts recorded for this project, grouped by the code they concern. " +
    "Use this to check what decisions and conventions have already been recorded before making " +
    "an architectural choice or recording a new fact.",
  {
    includeSuperseded: z
      .boolean()
      .optional()
      .describe("Optional: include superseded facts in a separate section (default: false)"),
  },
  async ({ includeSuperseded }) => {
    if (configError || !client) return configErrorContent();
    return safeCall(async () => {
      const facts = await listMemoryFacts(client!, { includeSuperseded });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ facts, total: facts.length }),
          },
        ],
      };
    });
  },
);

/* ------------------------------------------------------------------ */
/* startMcpServer — called by src/cli.ts `hydracode mcp`               */
/* ------------------------------------------------------------------ */

/**
 * Connect the McpServer to stdio and block until the connection closes.
 * Called by the CLI's `mcp` command action; nothing else should call this.
 *
 * CRITICAL: after this returns the process will exit. Do not call any
 * function that writes to stdout before or after this — the MCP transport
 * owns stdout for the duration of the connection.
 */
export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // server.connect() blocks until the transport closes (client disconnects).
}
