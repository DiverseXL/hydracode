/**
 * src/graph/duplicateCheck.ts
 *
 * Duplicate-risk check: given a proposed function name, query the live graph
 * for existing functions that might already do the same job, so an agent can
 * ask "am I about to duplicate something that already exists?" BEFORE writing
 * new code.
 *
 * MATCHING STRATEGY — layered, cheapest-and-most-confident first (all against
 * the live graph, never guessed):
 *   1. EXACT name match anywhere (high / exact_name). If
 *      `writeExtractedFiles` already exists and someone is about to write
 *      another `writeExtractedFiles`, that is the strongest possible signal.
 *      Dotted proposals ("HydraClient.query") additionally match a function's
 *      qualifiedName.
 *   2. SIMILAR name (high or medium / similar_name). Normalize both the
 *      proposed name and every indexed Function name into lowercase word
 *      tokens (camelCase / snake_case / PascalCase all collapse to the same
 *      form), then compare token SETS in-memory: identical sets → high
 *      ("getUserData" vs "get_user_data"); sets sharing all-but-a-couple of
 *      tokens → medium ("getUser" vs "getUserById"). This comparison is done
 *      in the Node client on one `MATCH (f:Function) RETURN f.key, f.name`
 *      query — the grammar has NO CONTAINS / case-insensitive operator, so
 *      fuzzy matching inside Cypher is off the table. No Levenshtein library:
 *      simple token-set logic is sufficient, cheap (function count is small
 *      even for a large codebase), and easy to explain in a demo.
 *   3. SAME-FILE similar purpose (low / same_file_similar_purpose, ONLY when
 *      opts.targetFile is provided). Functions already in the target file
 *      that share at least one token with the proposed name — catches "you're
 *      about to add a second, slightly-differently-named helper that does
 *      roughly the same job as one already in this file."
 *
 * HONESTY RULES: if the graph has no indexed functions, the result says so
 * explicitly ("run hydracode index first") instead of returning a false
 * negative "safe to proceed" — an empty graph proves nothing.
 */

import { unwrapValue } from "../hydra/client.js";
import type { HydraClient } from "../hydra/client.js";
import { NODE_LABELS, REL_TYPES } from "./schema.js";

export interface DuplicateCandidate {
  /** Logical key, e.g. `function:src/graph/writer.ts#writeExtractedFiles#504`. */
  key: string;
  /** Repo-relative file path parsed from the key, e.g. `src/graph/writer.ts`. */
  file: string;
  /** Start line parsed from the key. */
  line: number;
  matchReason: "exact_name" | "similar_name" | "same_file_similar_purpose";
  confidence: "high" | "medium" | "low";
}

export interface DuplicateCheckResult {
  candidates: DuplicateCandidate[];
  /** Short, plain-English summary safe to surface directly to an agent. */
  message: string;
}

/** Cap on returned candidates (spec: 5). */
const MAX_CANDIDATES = 5;

const CONFIDENCE_RANK: Record<DuplicateCandidate["confidence"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/* ------------------------------------------------------------------ */
/* Key / cell helpers                                                  */
/* ------------------------------------------------------------------ */

/** Parse a `function:<file>#<qualifiedName>#<line>` key into its parts. */
function parseFunctionKey(key: string): {
  file: string;
  qualifiedName: string;
  line: number;
} {
  const body = key.startsWith("function:") ? key.slice("function:".length) : key;
  const parts = body.split("#");
  const file = parts[0] ?? "";
  const qualifiedName = parts[1] ?? "";
  const line = Number(parts[2]);
  return { file, qualifiedName, line: Number.isFinite(line) ? line : 0 };
}

/**
 * The function's display name for messages: the qualifiedName segment of the
 * key (e.g. `HydraClient.query`, or `writeExtractedFiles` for a top-level fn).
 */
export function functionNameFromKey(key: string): string {
  const { qualifiedName } = parseFunctionKey(key);
  return qualifiedName !== "" ? qualifiedName : key;
}

function cellStr(v: unknown): string {
  const u = unwrapValue(v);
  return typeof u === "string" ? u : String(u ?? "");
}

function rowCells(row: unknown): unknown[] {
  if (Array.isArray(row)) return row;
  if (row !== null && typeof row === "object") {
    return Object.values(row as Record<string, unknown>);
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Token normalization (in-memory — see file header)                   */
/* ------------------------------------------------------------------ */

/**
 * Split any common naming convention into lowercase word tokens:
 *   "getUserData" / "get_user_data" / "GetUserData" → [get, user, data]
 * camelCase boundaries and leading-acronym runs are split; snake/kebab
 * separators are handled by the split on non-alphanumerics.
 *
 * Exported so memory/store.ts can apply the same tokenization to fact text
 * for recall matching (same style, one implementation).
 */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase / PascalCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // acronym run, e.g. "HTTPClient"
    .split(/[^A-Za-z0-9]+/) // snake_case / kebab-case / spaces
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

function toSet(tokens: string[]): Set<string> {
  return new Set(tokens);
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

export async function checkDuplicateRisk(
  client: HydraClient,
  proposedName: string,
  opts?: { targetFile?: string },
): Promise<DuplicateCheckResult> {
  const name = proposedName.trim();
  if (name.length === 0) {
    return {
      candidates: [],
      message: "No function name provided — nothing to check.",
    };
  }

  // One query for every Function node: key (identity) + name (matching).
  // Labeled MATCH + property projection — the same proven shape as
  // findByName in graph/query.ts.
  const res = await client.query(
    `MATCH (f:${NODE_LABELS.FUNCTION}) RETURN f.key AS key, f.name AS name`,
    undefined,
    { consistency: "strong" },
  );

  const functions: { key: string; name: string; file: string; line: number; qualifiedName: string }[] =
    [];
  for (const row of res.rows) {
    const cells = rowCells(row);
    const key = cellStr(cells[0]);
    const name_ = cellStr(cells[1]);
    const parsed = parseFunctionKey(key);
    functions.push({ key, name: name_, ...parsed });
  }

  // Honesty first: an empty graph cannot prove anything.
  if (functions.length === 0) {
    return {
      candidates: [],
      message:
        "The code graph has no indexed functions yet — run `hydracode index` first. " +
        "Duplicate risk cannot be verified against an empty graph.",
    };
  }

  const proposedTokens = toSet(nameTokens(name));
  const targetFile = normalizePath(opts?.targetFile);

  // Working candidates carry an internal token-overlap count so the final
  // sort can surface the closest matches first within the same confidence.
  const working: {
    key: string;
    file: string;
    line: number;
    qualifiedName: string;
    matchReason: DuplicateCandidate["matchReason"];
    confidence: DuplicateCandidate["confidence"];
    overlap: number;
  }[] = [];
  const seen = new Set<string>();

  const addCandidate = (
    fn: (typeof functions)[number],
    matchReason: DuplicateCandidate["matchReason"],
    confidence: DuplicateCandidate["confidence"],
  ): void => {
    if (seen.has(fn.key)) return;
    seen.add(fn.key);
    working.push({
      key: fn.key,
      file: fn.file,
      line: fn.line,
      qualifiedName: fn.qualifiedName,
      matchReason,
      confidence,
      overlap: intersectionSize(toSet(nameTokens(fn.name)), proposedTokens),
    });
  };

  // Layer 1: exact name match (also matches dotted qualifiedName proposals).
  for (const fn of functions) {
    if (fn.name === name || fn.qualifiedName === name) {
      addCandidate(fn, "exact_name", "high");
    }
  }

  // Layer 2: normalized token-set similarity, in-memory.
  for (const fn of functions) {
    if (seen.has(fn.key)) continue;
    const tokens = toSet(nameTokens(fn.name));
    if (setsEqual(tokens, proposedTokens)) {
      addCandidate(fn, "similar_name", "high");
      continue;
    }
    const inter = intersectionSize(tokens, proposedTokens);
    const symDiff = tokens.size + proposedTokens.size - 2 * inter;
    const smaller = Math.min(tokens.size, proposedTokens.size);
    // "Significant overlap" = share all but a token or two. Require the
    // SMALLER set to have >= 2 tokens so a bare generic verb ("get", "set")
    // never flags every function that starts with it: "getGraphStatus" must
    // not flag an unrelated 1-token "get" in another file.
    const isSubset = inter === smaller;
    if (
      (inter >= 2 && symDiff <= 2) ||
      (isSubset && symDiff <= 2 && smaller >= 2)
    ) {
      addCandidate(fn, "similar_name", "medium");
    }
  }

  // Layer 3: same-file loose token overlap (only when a target file is given).
  if (targetFile !== undefined) {
    for (const fn of functions) {
      if (seen.has(fn.key)) continue;
      if (normalizePath(fn.file) !== targetFile) continue;
      const tokens = toSet(nameTokens(fn.name));
      if (intersectionSize(tokens, proposedTokens) >= 1) {
        addCandidate(fn, "same_file_similar_purpose", "low");
      }
    }
  }

  // Sort by confidence (high first), then by token overlap (closest first),
  // then by key for stability. Cap at MAX_CANDIDATES.
  const candidates: DuplicateCandidate[] = working
    .sort((a, b) => {
      const rankDiff = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
      if (rankDiff !== 0) return rankDiff;
      const overlapDiff = b.overlap - a.overlap;
      if (overlapDiff !== 0) return overlapDiff;
      return a.key.localeCompare(b.key);
    })
    .slice(0, MAX_CANDIDATES)
    .map(({ key, file, line, matchReason, confidence }) => ({
      key,
      file,
      line,
      matchReason,
      confidence,
    }));

  let message = composeMessage(name, candidates);

  // Surface previously-recorded deliberate-duplicate decisions about the
  // matched functions, so an agent isn't warned a second time about a
  // decision that was already made and recorded on purpose.
  const recorded = await findRecordedDecisions(client, candidates);
  if (recorded.length > 0) {
    message +=
      "\n\nNote: an active memory fact already records a deliberate-duplicate decision about one of these matches " +
      `(${recorded.map((r) => r.factKey).join(", ")}): "${truncate(recorded[0].text, 160)}". ` +
      "Review it before writing the function anyway.";
  }

  return { candidates, message };
}

/* ------------------------------------------------------------------ */
/* Recorded-decision surfacing                                         */
/* ------------------------------------------------------------------ */

interface RecordedDecision {
  factKey: string;
  text: string;
  createdAt: string;
}

/**
 * Active MemoryFact nodes ABOUT any of the candidate function keys (one
 * small query per candidate — bounded by the 5-candidate cap). Used to tell
 * a later check "this duplicate was already decided on, on purpose".
 */
async function findRecordedDecisions(
  client: HydraClient,
  candidates: DuplicateCandidate[],
): Promise<RecordedDecision[]> {
  const found: RecordedDecision[] = [];
  for (const c of candidates) {
    const res = await client.query(
      `MATCH (m:${NODE_LABELS.MEMORY_FACT})-[:${REL_TYPES.ABOUT}]->(f:${NODE_LABELS.FUNCTION}) WHERE f.key = $key AND m.status = 'active' RETURN m.key AS factKey, m.text AS text, m.createdAt AS createdAt`,
      { key: c.key },
      { consistency: "strong" },
    );
    for (const row of res.rows) {
      const cells = rowCells(row);
      const factKey = cellStr(cells[0]);
      if (factKey !== "" && !found.some((r) => r.factKey === factKey)) {
        found.push({ factKey, text: cellStr(cells[1]), createdAt: cellStr(cells[2]) });
      }
    }
  }
  return found;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/* ------------------------------------------------------------------ */
/* Message composition                                                 */
/* ------------------------------------------------------------------ */

function reasonText(reason: DuplicateCandidate["matchReason"]): string {
  switch (reason) {
    case "exact_name":
      return "exact name match";
    case "similar_name":
      return "similar name";
    case "same_file_similar_purpose":
      return "similar purpose";
  }
}

function describeCandidate(c: DuplicateCandidate): string {
  return `${functionNameFromKey(c.key)} (${reasonText(c.matchReason)} in ${c.file})`;
}

function composeMessage(proposedName: string, candidates: DuplicateCandidate[]): string {
  if (candidates.length === 0) {
    return "No existing functions with a similar name or purpose were found. Safe to proceed.";
  }

  const descriptions = candidates.map(describeCandidate);
  let list: string;
  if (descriptions.length === 1) {
    list = descriptions[0];
  } else if (descriptions.length === 2) {
    list = `${descriptions[0]} and ${descriptions[1]}`;
  } else {
    list = `${descriptions.slice(0, -1).join(", ")}, and ${descriptions[descriptions.length - 1]}`;
  }

  const noun = candidates.length === 1 ? "function" : "functions";
  const reuseHint =
    candidates.length === 1
      ? "Consider reusing or extending it instead of writing a new function."
      : "Consider reusing or extending one of these instead of writing a new function.";

  return (
    `Found ${candidates.length} existing ${noun} that may already do this ` +
    `(for "${proposedName}"): ${list}. ${reuseHint}`
  );
}

/* ------------------------------------------------------------------ */
/* Path normalization                                                  */
/* ------------------------------------------------------------------ */

/** Normalize a repo path for comparison: backslashes → slashes, drop leading ./ */
function normalizePath(p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}
