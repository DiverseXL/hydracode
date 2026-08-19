/**
 * Shared ask pipeline — the intent-routing and graph query logic originally
 * inlined in src/cli.ts, extracted so both the CLI and the MCP tool call
 * exactly one implementation.
 *
 * Returns structured JSON: no ANSI colour codes, no console output. The CLI
 * renders the result with picocolors; the MCP tool serialises it as-is.
 */

import type { HydraClient } from "../hydra/client.js";
import {
  findByName,
  getCallers,
  getCallees,
  getPathEvidence,
  getTests,
  parseAskQuery,
  MAX_HOPS,
} from "./query.js";
import type { GraphNodeRef } from "./query.js";
import { NODE_LABELS } from "./schema.js";
import { recallMemoryFacts } from "../memory/store.js";

/* ------------------------------------------------------------------ */
/* Public result types                                                  */
/* ------------------------------------------------------------------ */

/** A single caller / callee / test result node. */
export interface AskResultNode {
  /** Logical key, e.g. `function:src/graph/writer.ts#writeExtractedFiles#45` */
  key: string;
  /** Friendly path segment, e.g. `src/graph/writer.ts#writeExtractedFiles` */
  display: string;
  /** File path stripped of the type prefix. */
  file: string;
  /** Start line from the key (when present). */
  line?: number;
}

/** A rendered path from getPathEvidence. */
export interface AskEvidencePath {
  /**
   * Triplet chain, e.g. `[HydraClient.query] -[:CALLS]-> [extractRows]`.
   * Falls back to a plain ` → ` arrow chain when the path carried no
   * parseable relationship types.
   */
  pathText: string;
  /** Relationship type per hop (same ordering as the pathText chain). */
  rels?: string[];
  weight?: number;
}

/** A candidate node when resolution is ambiguous. */
export interface AskAmbiguousCandidate {
  name: string;
  key: string;
  label: string;
}

/** Structured result returned by runAskPipeline. */
export interface AskPipelineResult {
  resolved: boolean;
  /** Present when question parsed to zero identifiers. */
  parseError?: string;
  /** Present when resolution found >1 match for the same name. */
  ambiguousCandidates?: AskAmbiguousCandidate[];
  /** Present when name(s) not found in the graph. */
  notFound?: string;
  /** The resolved anchor node, when resolved is true. */
  anchor?: { key: string; label: string };
  /** Callers / callees / tests, depending on intent. */
  results?: AskResultNode[];
  /** path evidence chains from getPathEvidence. */
  evidence?: AskEvidencePath[];
  /**
   * Human-readable summary sentence, e.g. "found 15 callers of writeExtractedFiles".
   * Intended for the MCP tool's message field and the CLI's heading line.
   */
  message?: string;
  intent?: "callers" | "callees" | "tests" | "general";
  /** Memory facts about the anchor node or its immediate call neighbors. */
  relatedMemory?: {
    key: string;
    text: string;
    about: string[];
    createdAt: string;
  }[];
}

/* ------------------------------------------------------------------ */
/* runAskPipeline                                                       */
/* ------------------------------------------------------------------ */

/**
 * Execute the full ask pipeline:
 *   1. Parse question → candidateNames + intent
 *   2. Resolve names against the graph (exact match then case-insensitive)
 *   3. Route to getCallers / getCallees / getTests / getCallees+getTests
 *   4. Fetch path evidence for callers/callees intents
 *
 * Never writes to stdout. Returns a structured AskPipelineResult object;
 * rendering (ANSI / JSON serialisation) is the caller's responsibility.
 */
export async function runAskPipeline(
  client: HydraClient,
  question: string,
  maxHops: number = MAX_HOPS,
): Promise<AskPipelineResult> {
  const hops = Math.min(Math.max(1, maxHops), MAX_HOPS);

  // Step 1: Heuristic parse.
  const { candidateNames, intent } = parseAskQuery(question);
  if (candidateNames.length === 0) {
    return {
      resolved: false,
      parseError:
        "I couldn't pick out any code identifiers from that question. " +
        'Try naming a function or class, e.g. `ask "what calls writeExtractedFiles"`.',
    };
  }

  // Step 2: Resolve each candidate name, most specific first.
  const perName = new Map<string, GraphNodeRef[]>();
  let anchor: GraphNodeRef | undefined;
  for (const name of candidateNames) {
    const matches = await findByName(client, name);
    if (matches.length === 0) continue;
    perName.set(name, matches);
    if (anchor === undefined && matches.length === 1) {
      anchor = matches[0];
    }
  }

  if (anchor === undefined) {
    const ambiguous = [...perName.entries()].filter(([, ms]) => ms.length > 1);
    if (ambiguous.length > 0) {
      const candidates: AskAmbiguousCandidate[] = ambiguous.flatMap(
        ([name, matches]) =>
          matches.map((m) => ({ name, key: m.key, label: m.label })),
      );
      return {
        resolved: false,
        ambiguousCandidates: candidates,
        message:
          "Multiple matches — re-ask with a more specific name (e.g. the exact function or file path).",
      };
    }
    return {
      resolved: false,
      notFound: `Couldn't find anything named ${candidateNames.map((n) => `"${n}"`).join(" or ")} in the indexed graph — try running \`hydracode index\` first, or check the spelling.`,
    };
  }

  // Step 3: Anchor resolved — handle the File shortcut.
  if (anchor.label === NODE_LABELS.FILE && intent !== "general") {
    const filePath = anchor.key.replace(/^file:/, "");
    return {
      resolved: true,
      anchor: { key: anchor.key, label: anchor.label },
      intent,
      message: `${filePath} is a file — callers/callees are tracked per function; try naming a function inside it.`,
      results: [],
    };
  }

  // Step 4: Intent routing.
  let nodes: GraphNodeRef[] = [];

  if (intent === "callers") {
    nodes = await getCallers(client, anchor.id, hops);
  } else if (intent === "callees") {
    nodes = await getCallees(client, anchor.id, hops);
  } else if (intent === "tests") {
    nodes = await getTests(client, anchor.id);
  } else {
    // general: callees + tests
    const callees = await getCallees(client, anchor.id, hops);
    const tests = await getTests(client, anchor.id);
    nodes = [...callees, ...tests];
  }

  const results: AskResultNode[] = nodes.map(nodeRefToResult);

  // Step 5: Path evidence for callers/callees.
  const evidence: AskEvidencePath[] = [];
  if (intent === "callers" || intent === "callees") {
    const paths = await getPathEvidence(client, anchor.id, { maxLen: hops });
    for (const p of paths.slice(0, 8)) {
      if (p.parseSucceeded) {
        evidence.push({
          pathText: renderPathTriplet(p.nodes, p.rels),
          rels: p.rels,
          weight: p.weight,
        });
      }
    }
  }

  const intentVerb =
    intent === "callers"
      ? "callers"
      : intent === "callees"
        ? "callees"
        : intent === "tests"
          ? "tests"
          : "related nodes";

  const anchorDisplay = describeKey(anchor.key);
  const message =
    results.length === 0
      ? `no ${intentVerb} found for ${anchorDisplay}`
      : `found ${results.length} ${intentVerb} for ${anchorDisplay}`;

  // Step 6: Memory enrichment — fetch facts about the anchor or its neighbors.
  // Memory is additive; if recall fails, omit rather than breaking the ask.
  let relatedMemory: AskPipelineResult["relatedMemory"];
  try {
    // Extract the function name from the anchor key for nearNode lookup.
    // Key format: `function:src/a.ts#writeExtractedFiles#503` → `writeExtractedFiles`
    const nearName = anchor.name ?? pathSegmentDisplay(anchor.key);
    if (nearName.length > 0) {
      const memoryFacts = await recallMemoryFacts(client, {
        nearNode: nearName,
        query: "",
      });
      if (memoryFacts.length > 0) {
        // Cap at 3: sort by trust (desc), then recency (desc).
        const sorted = memoryFacts
          .sort((a, b) => b.trust - a.trust || b.createdAt.localeCompare(a.createdAt))
          .slice(0, 3);
        relatedMemory = sorted.map((f) => ({
          key: f.key,
          text: f.text,
          about: f.about,
          createdAt: f.createdAt,
        }));
      }
    }
  } catch (err) {
    // Memory enrichment is best-effort — log to stderr, never fail the ask.
    process.stderr.write(
      `[askPipeline] memory enrichment failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const result: AskPipelineResult = {
    resolved: true,
    anchor: { key: anchor.key, label: anchor.label },
    intent,
    results,
    evidence,
    message,
  };
  if (relatedMemory !== undefined) {
    result.relatedMemory = relatedMemory;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Key formatting helpers (pure — no rendering-library imports)        */
/* ------------------------------------------------------------------ */

/**
 * `function:src/a.ts#foo#12` → `src/a.ts#foo:12`
 * `file:src/a.ts` → `src/a.ts`
 */
export function describeKey(key: string): string {
  const bare = key.replace(/^(file|module|function|class|test|memory):/, "");
  const parts = bare.split("#");
  if (key.startsWith("function:") || key.startsWith("test:")) {
    if (parts.length >= 3) {
      const line = parts.pop();
      return `${parts.join("#")}:${line}`;
    }
  }
  return bare;
}

/** Strip line suffix for arrow-chain rendering: `src/a.ts#foo#12` → `src/a.ts#foo`. */
export function chainDisplay(key: string): string {
  const bare = key.replace(/^(file|module|function|class|test|memory):/, "");
  const parts = bare.split("#");
  if (key.startsWith("function:") || key.startsWith("test:")) {
    parts.pop();
  }
  return parts.join("#");
}

/**
 * Display label for one node in a triplet path — the function/method's
 * qualified name (e.g. `HydraClient.query`, `extractRows`), the class name,
 * or the bare path for File/Module nodes.
 */
export function pathSegmentDisplay(key: string): string {
  const bare = key.replace(/^(file|module|function|class|test|memory):/, "");
  if (key.startsWith("function:") || key.startsWith("test:")) {
    // function:file#QualifiedName#line / test:file#name#line
    const parts = bare.split("#");
    if (parts.length >= 3) return parts[parts.length - 2] ?? bare;
    return bare;
  }
  if (key.startsWith("class:")) {
    // class:file#ClassName
    const parts = bare.split("#");
    return parts[parts.length - 1] ?? bare;
  }
  return bare;
}

/**
 * Render a path as a triplet chain, e.g.
 * `[HydraClient.query] -[:CALLS]-> [extractRows] -[:CALLS]-> [unwrapValue]`.
 * Falls back to a plain arrow chain when the rel types are unavailable.
 */
function renderPathTriplet(
  nodes: { key: string }[],
  rels: string[] | undefined,
): string {
  const labels = nodes.map((n) => pathSegmentDisplay(n.key));
  if (rels === undefined || rels.length !== nodes.length - 1) {
    return labels.join(" \u2192 ");
  }
  let text = `[${labels[0]}]`;
  for (let i = 0; i < rels.length; i++) {
    text += ` -[:${rels[i]}]-> [${labels[i + 1]}]`;
  }
  return text;
}

/** Map a GraphNodeRef to an AskResultNode. */
function nodeRefToResult(ref: GraphNodeRef): AskResultNode {
  const display = describeKey(ref.key);
  const bare = ref.key.replace(/^(file|module|function|class|test|memory):/, "");
  const file = bare.split("#")[0] ?? bare;
  const parts = bare.split("#");
  const lastPart = parts[parts.length - 1];
  const line =
    parts.length >= 3 && lastPart !== undefined && /^\d+$/.test(lastPart)
      ? parseInt(lastPart, 10)
      : undefined;
  return { key: ref.key, display, file, line };
}

/* ------------------------------------------------------------------ */
/* resolveSymbol — single-name resolution for callers/callees/impact   */
/* ------------------------------------------------------------------ */

/**
 * Resolve a single symbol name against the graph, returning a clean
 * discriminated union. Used by the CLI callers/callees/impact commands
 * and the MCP tools of the same name — avoids copy-pasted resolution
 * logic across multiple handlers.
 */
export async function resolveSymbol(
  client: HydraClient,
  symbol: string,
): Promise<
  | { resolved: true; node: GraphNodeRef }
  | {
      resolved: false;
      ambiguous: boolean;
      candidates?: { key: string; label: string }[];
      message: string;
    }
> {
  const matches = await findByName(client, symbol);

  if (matches.length === 0) {
    return {
      resolved: false,
      ambiguous: false,
      message:
        `No indexed function named "${symbol}" — run \`hydracode index\` first, or check the spelling.`,
    };
  }

  if (matches.length === 1) {
    return { resolved: true, node: matches[0] };
  }

  // Ambiguous: multiple nodes share this name.
  return {
    resolved: false,
    ambiguous: true,
    candidates: matches.map((m) => ({
      key: m.key,
      label: describeKey(m.key),
    })),
    message:
      `Multiple nodes named "${symbol}" — re-run with a more specific name (e.g. the exact function or file path).`,
  };
}
