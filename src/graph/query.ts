/**
 * Graph retrieval primitives for `hydracode ask` (src/cli.ts).
 *
 * GRAMMAR CONSTRAINTS (confirmed against a live HydraDB instance +
 * src/query/opencypher.rs / src/query/path_procedure.rs — see the engine's
 * cypher-compat.md; do not deviate):
 * - A node-only `MATCH (n)` needs an id, label, or INLINE property
 *   predicate; a WHERE clause does NOT satisfy that requirement
 *   (verified: `MATCH (n) WHERE n.name = ...` is rejected).
 * - RETURN projects `<binding>.<property>` or aggregates (`count(*)`, ...);
 *   `DISTINCT` on the projection, `ORDER BY`, `LIMIT` are supported. Path
 *   procedures may additionally RETURN `path`/`pathWeight`/`pathCost`
 *   after YIELDing them.
 * - Variable-length MATCH requires a FIXED id on the LEFT node and one
 *   relationship type with a mandatory hop range: `({id}) -[:R*1..N]-> (v)`.
 *   The target-fixed incoming form `(v)-[:R*1..N]->({id})` is REJECTED, so
 *   callers are gathered with fixed-hop patterns per depth (see
 *   getCallers) instead.
 * - WHERE supports `=`, `<>`, `<`, `>`, `<=`, `>=`, `STARTS WITH`, AND/OR/
 *   NOT. There is NO CONTAINS / IN / ENDS WITH and NO case-insensitive
 *   operator or string function, so name matching is exact `=` with a
 *   JS-side case-insensitive fallback (small graph) — never assume `=` is
 *   case-insensitive.
 * - algo.SSpaths/SPpaths take a literal/parameter integer sourceNode (and
 *   targetNode for SPpaths); algo.MSpaths takes sourceValues. The Path
 *   value shape (seen live): {"type":"path","value":{nodes:[...],
 *   relationships:[...]}} with Rust-wrapped property values
 *   ({"String": ...} / {"Integer": ...} / {"Bool": ...} / {"Float": ...}).
 *
 * INTENT HEURISTIC CAVEAT: parseAskQuery is a deliberately simple keyword
 * matcher, NOT real NLP. It is good enough for the demo's scripted
 * questions and will misfire on genuinely ambiguous phrasing. Upgrading to
 * an LLM-based intent classifier is a natural next step but out of scope.
 */

import { unwrapValue } from "../hydra/client.js";
import type { HydraClient } from "../hydra/client.js";
import { NODE_LABELS, REL_TYPES } from "./schema.js";
import type { NodeLabel, RelType } from "./schema.js";

/** Sane upper bound for traversals; the CLI flag is clamped to this. */
export const MAX_HOPS = 3;

/** Default labels searched by findByName. */
export const DEFAULT_SEARCH_LABELS: NodeLabel[] = [
  NODE_LABELS.FUNCTION,
  NODE_LABELS.CLASS,
  NODE_LABELS.FILE,
];

/** A node reference returned to callers: engine id + human-readable key. */
export interface GraphNodeRef {
  id: number;
  key: string;
  label: NodeLabel;
  /** Simple name when the node carries one (Function/ClassEntity.name). */
  name?: string;
}

/** One path returned by getPathEvidence (node sequence, not just endpoints). */
export interface HydraPathResult {
  /** Node refs in traversal order, source first. */
  nodes: GraphNodeRef[];
  /**
   * Relationship type per hop, `rels[i]` connects `nodes[i]` -> `nodes[i+1]`
   * (e.g. ["CALLS", "CALLS"] for a 3-node path). Undefined when the engine
   * response didn't carry parseable relationship entries.
   */
  rels?: string[];
  /** pathWeight, when the engine returned one. */
  weight?: number;
  /** True when the Path value parsed into `nodes`; false => see `raw`. */
  parseSucceeded: boolean;
  /** The raw Path value when parsing fell back (never throw on a new shape). */
  raw?: unknown;
}

/* ------------------------------------------------------------------ */
/* findByName                                                          */
/* ------------------------------------------------------------------ */

/**
 * Find nodes whose name matches `name`, searching one query per candidate
 * label (labels cannot be OR'd inside a single MATCH pattern). Exact `=`
 * match first; if nothing matches, a JS-side case-insensitive equality
 * fallback scans the (small) label sets — the engine has no
 * case-insensitive operator, so this is done in memory, and only for
 * equality (substring/contains matching is intentionally NOT invented).
 */
export async function findByName(
  client: HydraClient,
  name: string,
  opts?: { labels?: NodeLabel[] },
): Promise<GraphNodeRef[]> {
  const labels = opts?.labels ?? DEFAULT_SEARCH_LABELS;
  const results: GraphNodeRef[] = [];

  // Exact pass — one query per label. Function nodes additionally match
  // their qualifiedName (e.g. "HydraClient.unwrapValue") so the ambiguity
  // message's "be more specific" guidance is actually actionable.
  for (const label of labels) {
    const isFile = label === NODE_LABELS.FILE;
    const where = isFile
      ? "n.path = $name"
      : label === NODE_LABELS.FUNCTION
        ? "n.name = $name OR n.qualifiedName = $name"
        : "n.name = $name";
    // File nodes carry `path`, not `name` — project per label.
    const project = isFile ? "n.id, n.key, n.path" : "n.id, n.key, n.name";
    const res = await client.query(
      `MATCH (n:${label}) WHERE ${where} RETURN ${project}`,
      { name },
      { consistency: "strong" },
    );
    for (const row of res.rows) {
      results.push(rowToNodeRef(row, label));
    }
  }
  if (results.length > 0) return results;

  // Case-insensitive equality fallback (in-memory; graph is small) against
  // name / qualifiedName / path — the engine has no case-insensitive op.
  const lower = name.toLowerCase();
  for (const label of labels) {
    const isFile = label === NODE_LABELS.FILE;
    const project = isFile
      ? "n.id, n.key, n.path"
      : "n.id, n.key, n.name, n.qualifiedName";
    const res = await client.query(
      `MATCH (n:${label}) RETURN ${project}`,
      undefined,
      { consistency: "strong" },
    );
    for (const row of res.rows) {
      const cells = row as unknown[];
      const ref = rowToNodeRef(row, label);
      const haystacks =
        label === NODE_LABELS.FUNCTION
          ? [ref.name, unwrapValue(cells[3])].filter(
              (v): v is string => typeof v === "string",
            )
          : [ref.name].filter((v): v is string => v !== undefined);
      if (haystacks.some((v) => v.toLowerCase() === lower)) {
        results.push(ref);
      }
    }
  }
  return results;
}

/** Map one `RETURN n.id, n.key, n.<prop>` row to a GraphNodeRef. */
function rowToNodeRef(row: unknown, label: NodeLabel): GraphNodeRef {
  const cells = row as unknown[];
  const id = unwrapValue(cells[0]);
  const key = unwrapValue(cells[1]);
  const name = unwrapValue(cells[2]);
  return {
    id: typeof id === "number" ? id : 0,
    key: typeof key === "string" ? key : String(key),
    label,
    name: typeof name === "string" ? name : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Traversals: callers / callees                                       */
/* ------------------------------------------------------------------ */

/**
 * Functions that (transitively, up to maxHops) call `functionId`.
 *
 * The engine's variable-length MATCH requires the fixed id on the LEFT and
 * can only traverse OUTWARD, so the incoming form `(v)-[:CALLS*1..N]->({id})`
 * is rejected. Instead we run one fixed-hop pattern per depth — the target
 * carries the fixed id on the right, intermediates are anonymous, the
 * source is the caller — and dedupe across depths in JS:
 *   k=1: MATCH (a)-[:CALLS]->(b {id: $fnId})
 *   k=2: MATCH (a)-[:CALLS]->()-[:CALLS]->(b {id: $fnId})
 *   ...
 * maxHops is clamped to MAX_HOPS.
 */
export async function getCallers(
  client: HydraClient,
  functionId: number,
  maxHops: number = MAX_HOPS,
): Promise<GraphNodeRef[]> {
  const hops = Math.min(Math.max(1, Math.floor(maxHops)), MAX_HOPS);
  const seen = new Map<number, GraphNodeRef>();
  for (let k = 1; k <= hops; k++) {
    // Each extra hop needs its own typed relationship with a NAMED
    // intermediate node. Two verified engine constraints: (1) a bare `->(`
    // between nodes is a parse error (relationship type required); (2) the
    // engine does NOT join relationship patterns across ANONYMOUS `()` nodes
    // in fixed-length multi-hop MATCH — `(a)-[:CALLS]->()-[:CALLS]->(b
    // {id})` returned nodes with no real 2-hop path, while the named form
    // `(a)-[:CALLS]->(m)-[:CALLS]->(b {id})` is correct (verified live).
    const mids = Array.from(
      { length: k - 1 },
      (_, i) => `(m${i + 1})`,
    ).join("-[:CALLS]->");
    const pattern =
      mids.length > 0
        ? `(a)-[:CALLS]->${mids}-[:CALLS]->(b {id: $fnId})`
        : `(a)-[:CALLS]->(b {id: $fnId})`;
    const res = await client.query(
      `MATCH ${pattern} RETURN DISTINCT a.id, a.key`,
      { fnId: functionId },
      { consistency: "strong" },
    );
    for (const row of res.rows) {
      const cells = row as unknown[];
      const id = unwrapValue(cells[0]);
      const key = unwrapValue(cells[1]);
      if (typeof id === "number" && typeof key === "string" && !seen.has(id)) {
        seen.set(id, { id, key, label: labelFromKey(key) });
      }
    }
  }
  return [...seen.values()];
}

/**
 * Functions that `functionId` (transitively, up to maxHops) calls. Uses the
 * engine's supported outward variable-length form:
 *   MATCH ({id: $fnId})-[:CALLS*1..N]->(a) RETURN DISTINCT a.id, a.key
 */
export async function getCallees(
  client: HydraClient,
  functionId: number,
  maxHops: number = MAX_HOPS,
): Promise<GraphNodeRef[]> {
  const hops = Math.min(Math.max(1, Math.floor(maxHops)), MAX_HOPS);
  const res = await client.query(
    `MATCH ({id: $fnId})-[:CALLS*1..${hops}]->(a) RETURN DISTINCT a.id, a.key`,
    { fnId: functionId },
    { consistency: "strong" },
  );
  const results: GraphNodeRef[] = [];
  for (const row of res.rows) {
    const cells = row as unknown[];
    const id = unwrapValue(cells[0]);
    const key = unwrapValue(cells[1]);
    if (typeof id === "number" && typeof key === "string") {
      results.push({ id, key, label: labelFromKey(key) });
    }
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Tests                                                                */
/* ------------------------------------------------------------------ */

/**
 * Tests covering `targetId` (Function or ClassEntity), one hop via TESTS.
 *
 * KNOWN GAP: the writer currently stores Test NODES but never writes TESTS
 * edges (schema declares them as a best-effort relation; the extractor does
 * not yet produce test->target mappings), so this returns [] against the
 * current indexer. Implemented against the schema's confirmed shape so it
 * lights up the moment TESTS edges are written.
 */
export async function getTests(
  client: HydraClient,
  targetId: number,
): Promise<GraphNodeRef[]> {
  const res = await client.query(
    `MATCH (t:Test)-[:${REL_TYPES.TESTS}]->(target {id: $targetId}) RETURN t.id, t.key`,
    { targetId },
    { consistency: "strong" },
  );
  const results: GraphNodeRef[] = [];
  for (const row of res.rows) {
    const cells = row as unknown[];
    const id = unwrapValue(cells[0]);
    const key = unwrapValue(cells[1]);
    if (typeof id === "number" && typeof key === "string") {
      results.push({ id, key, label: NODE_LABELS.TEST });
    }
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Path evidence (algo.SSpaths)                                        */
/* ------------------------------------------------------------------ */

/**
 * Whole-path evidence out of `sourceId` via algo.SSpaths — the "show your
 * work" part of `ask`. Returns node sequences (not just endpoints) with the
 * Path value parsed defensively: if the response shape ever differs from
 * what we've confirmed live, the raw value is surfaced via `raw` with
 * `parseSucceeded: false` instead of throwing or silently returning empty.
 */
export async function getPathEvidence(
  client: HydraClient,
  sourceId: number,
  opts?: { relTypes?: RelType[]; maxLen?: number; pathCount?: number },
): Promise<HydraPathResult[]> {
  const relTypes = opts?.relTypes ?? [REL_TYPES.CALLS];
  const maxLen = opts?.maxLen ?? MAX_HOPS;
  const pathCount = opts?.pathCount ?? 10;

  const relList = `[${relTypes.map((r) => `'${r}'`).join(", ")}]`;
  const res = await client.query(
    `CALL algo.SSpaths({sourceNode: $sourceId, relTypes: ${relList}, maxLen: ${maxLen}, pathCount: ${pathCount}})
     YIELD path, pathWeight
     RETURN path, pathWeight`,
    { sourceId },
    { consistency: "strong" },
  );

  const paths: HydraPathResult[] = [];
  for (const row of res.rows) {
    const cells = row as unknown[];
    const pathCell = cells[0];
    const weightCell = cells[1];

    const parsed = parsePathCell(pathCell);
    const weight = unwrapValue(weightCell);
    if (parsed) {
      paths.push({
        nodes: parsed.nodes,
        rels: parsed.rels,
        weight: typeof weight === "number" ? weight : undefined,
        parseSucceeded: true,
      });
    } else {
      // Fallback: surface the raw value rather than failing the whole ask.
      paths.push({
        nodes: [],
        weight: typeof weight === "number" ? weight : undefined,
        parseSucceeded: false,
        raw: pathCell,
      });
    }
  }
  return paths;
}

/**
 * Defensively parse a `{type: "path", value: {nodes, relationships}}` cell
 * (shape confirmed live) into ordered GraphNodeRefs plus per-hop rel types.
 * Returns undefined when the NODE shape doesn't match what we know, so the
 * caller can surface raw data. Relationship entries are parsed leniently:
 * if they can't be parsed the nodes still win (rels: undefined), because
 * losing a path's nodes to a rel-shape drift would be a worse regression.
 */
function parsePathCell(
  cell: unknown,
): { nodes: GraphNodeRef[]; rels: string[] | undefined } | undefined {
  if (cell === null || typeof cell !== "object") return undefined;
  const record = cell as Record<string, unknown>;
  if (record.type !== "path") return undefined;
  const value = record.value;
  if (value === null || typeof value !== "object") return undefined;
  const nodes = (value as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return undefined;

  const refs: GraphNodeRef[] = [];
  for (const node of nodes) {
    if (node === null || typeof node !== "object") return undefined;
    const n = node as Record<string, unknown>;
    const id = n.id;
    if (typeof id !== "number") return undefined;
    const props = n.properties;
    const key =
      props !== null && typeof props === "object"
        ? unwrapRustScalar((props as Record<string, unknown>).key)
        : undefined;
    if (typeof key !== "string") return undefined;
    refs.push({ id, key, label: labelFromKey(key) });
  }

  // Relationships: `rels[i]` is the type connecting nodes[i] -> nodes[i+1].
  // The engine reports the type as `edge_type` (plain string) on each
  // relationship entry — confirmed live (see file header).
  const relationships = (value as Record<string, unknown>).relationships;
  let rels: string[] | undefined;
  if (Array.isArray(relationships)) {
    const parsedRels: string[] = [];
    let ok = true;
    for (const rel of relationships) {
      if (rel === null || typeof rel !== "object") {
        ok = false;
        break;
      }
      const t = unwrapRustScalar(
        (rel as Record<string, unknown>).edge_type ??
          (rel as Record<string, unknown>).type,
      );
      if (typeof t !== "string") {
        ok = false;
        break;
      }
      parsedRels.push(t);
    }
    if (ok && parsedRels.length === refs.length - 1) {
      rels = parsedRels;
    }
  }

  return { nodes: refs, rels };
}

/** Unwrap {"String": s} / {"Integer": n} / {"Bool": b} / {"Float": n}. */
function unwrapRustScalar(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const record = v as Record<string, unknown>;
  if ("String" in record) return record.String;
  if ("Integer" in record) return record.Integer;
  if ("Float" in record) return record.Float;
  if ("Bool" in record) return record.Bool;
  return v;
}

/* ------------------------------------------------------------------ */
/* Intent detection (deliberately simple — see file header)            */
/* ------------------------------------------------------------------ */

export type AskIntent = "callers" | "callees" | "tests" | "general";

export interface ParsedAskQuery {
  /** Probable code-identifier tokens extracted from the question. */
  candidateNames: string[];
  intent: AskIntent;
}

/** Words that are clearly not code identifiers (function words + ask verbs). */
const STOPWORDS = new Set([
  // English function words
  "a", "about", "above", "after", "again", "against", "all", "am", "an",
  "and", "any", "are", "as", "at", "be", "because", "been", "before",
  "being", "below", "between", "both", "but", "by", "can", "could",
  "did", "do", "does", "doing", "down", "during", "each", "few", "for",
  "from", "further", "had", "has", "have", "having", "he", "her",
  "here", "hers", "herself", "him", "himself", "his", "how", "i", "if",
  "in", "into", "is", "it", "its", "itself", "me", "more", "most",
  "much", "my", "myself", "no", "nor", "not", "of", "off", "on", "once",
  "only", "or", "other", "our", "ours", "ourselves", "out", "over",
  "own", "same", "she", "should", "so", "some", "such", "than", "that",
  "the", "their", "theirs", "them", "themselves", "then", "there",
  "these", "they", "this", "those", "through", "to", "too", "under",
  "until", "up", "very", "was", "we", "were", "what", "when", "where",
  "which", "while", "who", "whom", "why", "will", "with", "would",
  "you", "your", "yours", "yourself",
  // ask-domain verbs / framing words
  "call", "calls", "called", "calling", "callers", "callees", "covers",
  "cover", "covered", "test", "tests", "tested", "testing", "please",
  "show", "find", "get", "list", "tell", "give", "me", "many", "any",
]);

/** Token shape check: a plausible identifier (letters, digits, _, $). */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function looksLikeIdentifier(token: string): boolean {
  if (token.length < 2) return false;
  if (!IDENTIFIER_RE.test(token)) return false;
  if (STOPWORDS.has(token.toLowerCase())) return false;
  return true;
}

/**
 * Parse a natural-language-ish question into candidate identifier names and
 * an intent. Deliberately heuristic: backtick/quoted words are always
 * candidates; bare camelCase/PascalCase/snake_case tokens are candidates;
 * stopwords are filtered. See the file header for the honest caveat.
 */
export function parseAskQuery(question: string): ParsedAskQuery {
  const lower = question.toLowerCase();

  let intent: AskIntent = "general";
  if (/\b(callees?)\b/.test(lower)) {
    intent = "callees";
  } else if (
    /\b(call(?:s|ed|ing)?\s+by|who\s+calls|what\s+calls|callers?)\b/.test(lower)
  ) {
    intent = "callers";
  } else if (
    /\b(what\s+does\b.+\bcall|calls\s+(?:out\s+)?to)\b/.test(lower) ||
    /\bcalls\s+out\s+to\b/.test(lower)
  ) {
    intent = "callees";
  } else if (
    /\b(test(?:s|ed)?\s+by|tests?|cover(?:s|ed)?)\b/.test(lower)
  ) {
    intent = "tests";
  }

  const candidates = new Set<string>();

  // Backtick and single/double-quoted spans are always candidates.
  const quoted = question.matchAll(/[`"'“”]([^`"'“”]+)[`"'“”]/g);
  for (const m of quoted) {
    const t = m[1].trim();
    if (t.length > 0) candidates.add(t);
  }

  // Dotted qualified names (e.g. `HydraClient.unwrapValue`) are one token,
  // so the ambiguity guidance can actually be followed. Require every
  // segment to be at least two chars so "e.g."/"i.e." aren't captured.
  const dotted = question.matchAll(
    /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b/g,
  );
  const dottedNames: string[] = [];
  for (const m of dotted) {
    const segments = m[0].split(".");
    if (segments.every((s) => s.length >= 2)) {
      candidates.add(m[0]);
      dottedNames.push(m[0]);
    }
  }

  // Bare identifier-like tokens (not sub-tokens of a dotted candidate when
  // the dotted form is present — the qualified name is the specific one).
  for (const token of question.split(/[^A-Za-z0-9_$]+/)) {
    if (!looksLikeIdentifier(token)) continue;
    if (dottedNames.some((d) => d.split(".").includes(token))) continue;
    candidates.add(token);
  }

  // Order matters to callers: qualified/dotted names first (most specific),
  // then longer identifiers, so cli.ts resolves "HydraClient.unwrapValue"
  // before the ambiguous "unwrapValue".
  const ordered = [...candidates].sort((a, b) => {
    const aDotted = a.includes(".") ? 0 : 1;
    const bDotted = b.includes(".") ? 0 : 1;
    if (aDotted !== bDotted) return aDotted - bDotted;
    return b.length - a.length;
  });

  return { candidateNames: ordered, intent };
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Map a logical key's type prefix back to its NodeLabel. */
export function labelFromKey(key: string): NodeLabel {
  if (key.startsWith("file:")) return NODE_LABELS.FILE;
  if (key.startsWith("module:")) return NODE_LABELS.MODULE;
  if (key.startsWith("function:")) return NODE_LABELS.FUNCTION;
  if (key.startsWith("class:")) return NODE_LABELS.CLASS;
  if (key.startsWith("test:")) return NODE_LABELS.TEST;
  if (key.startsWith("memory:")) return NODE_LABELS.MEMORY_FACT;
  return NODE_LABELS.FUNCTION;
}

/* ------------------------------------------------------------------ */
/* Graph status                                                         */
/* ------------------------------------------------------------------ */

export interface GraphStatus {
  /** True when at least one Function node exists in the graph. */
  indexed: boolean;
  counts: {
    files: number;
    functions: number;
    classes: number;
    tests: number;
  };
}

/**
 * Run per-label COUNT(*) queries and return basic graph statistics.
 * Used by both `hydracode status` (CLI) and the `hydracode_status` MCP tool.
 */
export async function getGraphStatus(client: HydraClient): Promise<GraphStatus> {
  const [filesRes, functionsRes, classesRes, testsRes] = await Promise.all([
    client.query(
      `MATCH (n:${NODE_LABELS.FILE}) RETURN count(*) AS total`,
      undefined,
      { consistency: "strong" },
    ),
    client.query(
      `MATCH (n:${NODE_LABELS.FUNCTION}) RETURN count(*) AS total`,
      undefined,
      { consistency: "strong" },
    ),
    client.query(
      `MATCH (n:${NODE_LABELS.CLASS}) RETURN count(*) AS total`,
      undefined,
      { consistency: "strong" },
    ),
    client.query(
      `MATCH (n:${NODE_LABELS.TEST}) RETURN count(*) AS total`,
      undefined,
      { consistency: "strong" },
    ),
  ]);

  const extractCount = (res: { rows: unknown[] }): number => {
    const row = res.rows[0];
    if (Array.isArray(row)) {
      const v = unwrapValue(row[0]);
      return typeof v === "number" ? v : 0;
    }
    if (row !== null && typeof row === "object") {
      const record = row as Record<string, unknown>;
      const v = unwrapValue(record.total ?? record["count(*)"]);
      return typeof v === "number" ? v : 0;
    }
    return 0;
  };

  const counts = {
    files: extractCount(filesRes),
    functions: extractCount(functionsRes),
    classes: extractCount(classesRes),
    tests: extractCount(testsRes),
  };

  return { indexed: counts.functions > 0, counts };
}
