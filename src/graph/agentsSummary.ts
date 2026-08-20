/**
 * src/graph/agentsSummary.ts
 *
 * Builds a GraphSummary from live HydraDB data and renders it as a
 * clearly-delimited markdown block for AGENTS.md (`hydracode sync-agents-md`).
 *
 * AGGREGATION STRATEGY — VERIFIED AGAINST THE LIVE ENGINE:
 *   HydraDB's grammar DOES support grouped aggregation. A RETURN projection
 *   that mixes a binding property with count(*) (the openCypher implicit
 *   GROUP BY form) returns one row per distinct property value, NOT a single
 *   whole-result aggregate. Verified live against the running instance:
 *     MATCH (caller:Function)-[:CALLS]->(f:Function)
 *     RETURN f.key AS key, count(*) AS callers
 *     ORDER BY callers DESC LIMIT 7
 *   returns per-function caller counts (HydraClient.query top of the list at
 *   14 callers), and ORDER BY <aggregate> / LIMIT apply to the grouped
 *   result, so top-N slicing happens server-side. Every section below uses
 *   this server-side grouped form; no in-memory tally fallback is needed.
 *   (The file-header constraints in graph/query.ts remain the reference for
 *   what the grammar rejects — a node-only MATCH needs a label/predicate,
 *   variable-length MATCH needs a fixed left id, etc. All queries here carry
 *   explicit labels, satisfying those constraints.)
 *
 * QUERY BUDGET: status (4 counts) + fan-in (1) + most-connected (3, one per
 *   CONTAINS target label) + test coverage (1 edge-count, +2 only when TESTS
 *   edges exist) — a handful of small queries, fast on a codebase-sized graph.
 */

import { unwrapValue } from "../hydra/client.js";
import type { HydraClient } from "../hydra/client.js";
import { getGraphStatus } from "./query.js";
import { NODE_LABELS, REL_TYPES } from "./schema.js";
import type { NodeLabel } from "./schema.js";

// --- Public types ---

export interface FanInEntry {
  key: string;
  callers: number;
}

export interface FileConnectivity {
  path: string;
  functions: number;
  classes: number;
  tests: number;
  total: number;
}

export interface GraphSummary {
  lastSynced: string;
  indexed: boolean;
  counts: { files: number; functions: number; classes: number; tests: number };
  highFanIn: FanInEntry[];
  /** True when the graph has zero TESTS edges (linkage not tracked yet). */
  testsUnavailable: boolean;
  untestedExported: string[];
  mostConnected: FileConnectivity[];
  aggregationStrategy: "server-side" | "in-memory";
}

// --- Row helpers ---
/* Every query below returns rows as arrays of cells; cells are Rust-wrapped
 * values ({type, value}) that unwrapValue flattens. Helpers keep the mapping
 * code short and defensive against a missing/odd cell. */

function cellStr(v: unknown): string {
  const u = unwrapValue(v);
  return typeof u === "string" ? u : String(u ?? "");
}

function cellNum(v: unknown): number {
  const u = unwrapValue(v);
  return typeof u === "number" ? u : typeof u === "bigint" ? Number(u) : 0;
}

function rowCells(row: unknown): unknown[] {
  if (Array.isArray(row)) return row;
  if (row !== null && typeof row === "object") {
    return Object.values(row as Record<string, unknown>);
  }
  return [];
}

/** Top-N cap for every list section (spec: top 5-10). */
const TOP_N = 7;

// --- High fan-in functions ---

async function buildFanIn(client: HydraClient): Promise<FanInEntry[]> {
  const res = await client.query(
    `MATCH (caller:${NODE_LABELS.FUNCTION})-[:${REL_TYPES.CALLS}]->(f:${NODE_LABELS.FUNCTION}) RETURN f.key AS key, count(*) AS callers ORDER BY callers DESC LIMIT ${TOP_N}`,
    undefined,
    { consistency: "strong" },
  );
  return res.rows
    .map((row) => {
      const cells = rowCells(row);
      return { key: cellStr(cells[0]), callers: cellNum(cells[1]) };
    })
    .filter((e) => e.callers > 0);
}

// --- Most-connected files ---

async function buildMostConnected(client: HydraClient): Promise<FileConnectivity[]> {
  // One grouped query per CONTAINS target label gives the per-file breakdown
  // (functions/classes/tests); totals are summed in-memory from those.
  async function countByFile(targetLabel: NodeLabel): Promise<Map<string, number>> {
    const res = await client.query(
      `MATCH (f:${NODE_LABELS.FILE})-[:${REL_TYPES.CONTAINS}]->(n:${targetLabel}) RETURN f.path AS path, count(*) AS cnt`,
      undefined,
      { consistency: "strong" },
    );
    const m = new Map<string, number>();
    for (const row of res.rows) {
      const cells = rowCells(row);
      m.set(cellStr(cells[0]), cellNum(cells[1]));
    }
    return m;
  }

  const [functions, classes, tests] = await Promise.all([
    countByFile(NODE_LABELS.FUNCTION),
    countByFile(NODE_LABELS.CLASS),
    countByFile(NODE_LABELS.TEST),
  ]);

  const allPaths = new Set([...functions.keys(), ...classes.keys(), ...tests.keys()]);
  return Array.from(allPaths)
    .map((path) => {
      const fn = functions.get(path) ?? 0;
      const cl = classes.get(path) ?? 0;
      const te = tests.get(path) ?? 0;
      return { path, functions: fn, classes: cl, tests: te, total: fn + cl + te };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_N);
}

// --- Test coverage ---

async function buildTestCoverage(
  client: HydraClient,
): Promise<{ testsUnavailable: boolean; untestedExported: string[] }> {
  // The writer never creates TESTS edges today (the extractor does not yet
  // link tests to what they cover). If the whole graph has none, say so
  // honestly instead of reporting "0 untested functions" (which would read
  // as a clean bill of health when it actually means "we don't know").
  const edgeRes = await client.query(
    `MATCH (t:${NODE_LABELS.TEST})-[:${REL_TYPES.TESTS}]->(target) RETURN count(*) AS c`,
    undefined,
    { consistency: "strong" },
  );
  const edgeCount = edgeRes.rows.length > 0 ? cellNum(rowCells(edgeRes.rows[0])[0]) : 0;
  if (edgeCount === 0) {
    return { testsUnavailable: true, untestedExported: [] };
  }

  // TESTS edges exist: exported functions minus the ones a Test covers.
  const [exportedRes, testedRes] = await Promise.all([
    client.query(
      `MATCH (f:${NODE_LABELS.FUNCTION}) WHERE f.exported = true RETURN f.key AS key`,
      undefined,
      { consistency: "strong" },
    ),
    client.query(
      `MATCH (t:${NODE_LABELS.TEST})-[:${REL_TYPES.TESTS}]->(f:${NODE_LABELS.FUNCTION}) RETURN DISTINCT f.key AS key`,
      undefined,
      { consistency: "strong" },
    ),
  ]);

  const testedKeys = new Set(testedRes.rows.map((r) => cellStr(rowCells(r)[0])));
  const untested = exportedRes.rows
    .map((r) => cellStr(rowCells(r)[0]))
    .filter((k) => !testedKeys.has(k));
  return { testsUnavailable: false, untestedExported: untested.slice(0, TOP_N) };
}

// --- Main export ---

export async function buildGraphSummary(client: HydraClient): Promise<GraphSummary> {
  const [status, highFanIn, mostConnected, testCoverage] = await Promise.all([
    getGraphStatus(client),
    buildFanIn(client),
    buildMostConnected(client),
    buildTestCoverage(client),
  ]);

  return {
    lastSynced: new Date().toISOString(),
    indexed: status.indexed,
    counts: status.counts,
    highFanIn,
    testsUnavailable: testCoverage.testsUnavailable,
    untestedExported: testCoverage.untestedExported,
    mostConnected,
    aggregationStrategy: "server-side",
  };
}

// --- Markdown renderer ---

export const MARKER_START = "<!-- hydracode:graph-summary:start -->";
export const MARKER_END = "<!-- hydracode:graph-summary:end -->";

/** Strip the type prefix (function:/file:/...) for display; keep the rest. */
function displayKey(key: string): string {
  return key.replace(/^(function|class|test|file|module|memory):/, "");
}

function plural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`;
  if (word === "class") return `${n} classes`;
  return `${n} ${word}s`;
}

/**
 * Render the auto-generated AGENTS.md block. Plain, honest language — no
 * invented statistics. Sections with nothing to show state that explicitly,
 * so an agent reading the file can trust that an absence means "genuinely
 * zero / not applicable", not "we forgot to check".
 */
export function renderAgentsMdSection(summary: GraphSummary): string {
  const lines: string[] = [];

  lines.push(MARKER_START);
  lines.push(
    "<!-- Auto-generated by `hydracode sync-agents-md` from the indexed code",
    "     graph. Do not edit this section by hand -- it will be overwritten on",
    "     the next sync. Edit anything outside these markers freely. -->",
  );
  lines.push("");
  lines.push("## Code graph summary (auto-generated)");
  lines.push("");

  if (!summary.indexed) {
    lines.push("_The code graph is not indexed yet -- run `hydracode index` first._");
  } else {
    const { counts } = summary;
    lines.push(
      `_Last synced: ${summary.lastSynced} -- ` +
        `${plural(counts.files, "file")}, ${plural(counts.functions, "function")}, ` +
        `${plural(counts.classes, "class")}, ${plural(counts.tests, "test")} indexed._`,
    );
  }

  lines.push("");
  lines.push("### High fan-in functions (change with care -- many callers depend on these)");
  lines.push("");
  if (summary.highFanIn.length === 0) {
    lines.push(
      "_No CALLS edges found in the graph -- either nothing is indexed yet or no inter-function calls were resolved._",
    );
  } else {
    for (const entry of summary.highFanIn) {
      lines.push(`- \`${displayKey(entry.key)}\` -- ${plural(entry.callers, "caller")}`);
    }
  }

  lines.push("");
  lines.push("### Most-connected files");
  lines.push("");
  if (summary.mostConnected.length === 0) {
    lines.push("_No files with indexed symbols found in the graph._");
  } else {
    for (const f of summary.mostConnected) {
      const parts: string[] = [];
      if (f.functions > 0) parts.push(plural(f.functions, "function"));
      if (f.classes > 0) parts.push(plural(f.classes, "class"));
      if (f.tests > 0) parts.push(plural(f.tests, "test"));
      const breakdown = parts.length > 0 ? parts.join(", ") : "0 symbols";
      lines.push(`- \`${f.path}\` -- ${breakdown}`);
    }
  }

  lines.push("");
  lines.push("### Test coverage");
  lines.push("");
  if (summary.testsUnavailable) {
    lines.push(
      "_Not yet tracked -- hydracode does not currently link tests to the code they cover " +
        "(no TESTS edges are present in the graph). This is a known limitation; an empty list here " +
        "would be misleading, so this section stays explicitly empty. See the project README._",
    );
  } else if (summary.untestedExported.length === 0) {
    lines.push("_Every indexed exported function has at least one TESTS edge pointing at it._");
  } else {
    lines.push(
      `_Exported functions with no test coverage (showing up to ${summary.untestedExported.length}):_`,
    );
    lines.push("");
    for (const key of summary.untestedExported) {
      lines.push(`- \`${displayKey(key)}\``);
    }
  }

  lines.push("");
  lines.push(MARKER_END);

  return lines.join("\n");
}
