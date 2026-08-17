/**
 * src/memory/store.ts
 *
 * Temporal memory layer (Track 03): records decisions and rationales as
 * MemoryFact nodes in the same HydraDB graph as the code, so future agents
 * can see WHY something was done instead of rediscovering it.
 *
 * WRITE SHAPE — follows graph/writer.ts's proven UNWIND pattern exactly:
 *   - Rows travel as the `$rows` parameter (a list of maps) in the request
 *     body's `parameters` field, never inlined.
 *   - MERGE identity is GLOBAL and matched by `id` alone (`MERGE (n {id:
 *     ...})`, no label filter, no extra pattern properties); the label and
 *     properties are applied afterward via a single SET clause.
 *   - ids are integers: hashToVertexId over the LOGICAL key. Facts use
 *     `memory:<uuid>` (fresh node per record); ABOUT edges use the
 *     deterministic `<fromKey>->ABOUT-><toKey>` form so re-recording the
 *     same logical edge MERGEs instead of duplicating.
 *   - Node writes run BEFORE edge writes (edges MATCH their endpoints, which
 *     must already exist), with strong consistency between the two.
 */

import { randomUUID } from "node:crypto";
import { unwrapValue } from "../hydra/client.js";
import type { HydraClient } from "../hydra/client.js";
import type { DuplicateCandidate } from "../graph/duplicateCheck.js";
import { functionNameFromKey, nameTokens } from "../graph/duplicateCheck.js";
import { findByName } from "../graph/query.js";
import { hashToVertexId } from "../graph/hashId.js";
import { NODE_LABELS, REL_TYPES } from "../graph/schema.js";
import type { MemoryFactStatus, NodeLabel } from "../graph/schema.js";

/** A recorded fact, as returned to callers (the logical key is the identity). */
export interface MemoryFactRef {
  key: string;
  text: string;
  createdAt: string;
}

export interface RecordMemoryFactOptions {
  text: string;
  /** Optional nodes this fact is ABOUT (MemoryFact -> Function | ClassEntity | File). */
  about?: { key: string; label: NodeLabel }[];
  trust?: number;
  status?: MemoryFactStatus;
}

/* ------------------------- Cypher body templates ------------------------- */

const FACT_BODY = `MERGE (n {id: row.id})
SET n:${NODE_LABELS.MEMORY_FACT}, n.key = row.key, n.text = row.text, n.createdAt = row.createdAt, n.trust = row.trust, n.status = row.status`;

const aboutBody = (targetLabel: NodeLabel): string =>
  `MATCH (a:${NODE_LABELS.MEMORY_FACT} {id: row.fromId}), (b:${targetLabel} {id: row.toId})
MERGE (a)-[r:${REL_TYPES.ABOUT} {id: row.edgeId}]->(b)
SET r.key = row.edgeKey`;

/* ------------------------------ record ---------------------------------- */

/**
 * Write one MemoryFact node (and optional ABOUT edges) to the graph.
 * Idempotent per fact key: a fresh `memory:<uuid>` key means every call
 * records a distinct fact (this is a log of decisions, not a upsert).
 */
export async function recordMemoryFact(
  client: HydraClient,
  opts: RecordMemoryFactOptions,
): Promise<MemoryFactRef> {
  const createdAt = new Date().toISOString();
  const trust = opts.trust ?? 1;
  const status = opts.status ?? "active";
  const key = `memory:${randomUUID()}`;

  const factRow = {
    id: hashToVertexId(key),
    key,
    text: opts.text,
    createdAt,
    trust,
    status,
  };
  await client.query(
    `UNWIND $rows AS row\n${FACT_BODY}`,
    { rows: [factRow] },
    { consistency: "strong" },
  );

  // ABOUT edges, grouped per target label (the batch grammar requires
  // exactly one label per endpoint).
  const about = opts.about ?? [];
  const byLabel = new Map<NodeLabel, Record<string, unknown>[]>();
  for (const a of about) {
    const edgeKey = `${key}->${REL_TYPES.ABOUT}->${a.key}`;
    const rows = byLabel.get(a.label) ?? [];
    rows.push({
      fromId: hashToVertexId(key),
      toId: hashToVertexId(a.key),
      edgeId: hashToVertexId(edgeKey),
      edgeKey,
    });
    byLabel.set(a.label, rows);
  }
  for (const [label, rows] of byLabel) {
    await client.query(
      `UNWIND $rows AS row\n${aboutBody(label)}`,
      { rows },
      { consistency: "strong" },
    );
  }

  return { key, text: opts.text, createdAt };
}

/**
 * Record a deliberate-duplicate decision: the agent saw `candidates` from
 * checkDuplicateRisk and chose to write `proposedName` anyway. One active
 * MemoryFact (trust 1) with an ABOUT edge to every matched function, so a
 * later duplicate check can see the decision was intentional and recorded.
 */
/* --------------------------- record w/ about ---------------------------- */

/**
 * Record a fact, optionally linked via ABOUT to a node resolved by name
 * (function/class/file). Shared by the CLI (`memory record`) and the MCP
 * `hydracode_record_decision` tool so both paths resolve targets identically.
 * Resolution uses findByName, same as `ask`: exactly one match required,
 * zero or multiple matches raise a message telling the caller to be specific.
 */
export async function recordMemoryFactAbout(
  client: HydraClient,
  text: string,
  aboutName?: string,
): Promise<{ recorded: MemoryFactRef; about: { key: string; label: NodeLabel }[] }> {
  let about: { key: string; label: NodeLabel }[] = [];
  const name = aboutName?.trim() ?? "";
  if (name.length > 0) {
    const matches = await findByName(client, name);
    if (matches.length === 0) {
      throw new Error(
        `Couldn't find anything named "${name}" in the indexed graph — try \`hydracode index\` first, or check the spelling.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `"${name}" matched ${matches.length} nodes (${matches
          .map((m) => m.key)
          .join(", ")}). Be more specific — use the exact function qualified name or file path.`,
      );
    }
    about = [{ key: matches[0].key, label: matches[0].label }];
  }
  const recorded = await recordMemoryFact(client, { text, about });
  return { recorded, about };
}

/* ------------------------------ recall ---------------------------------- */

/** One recalled fact, as returned to callers. */
export interface MemoryFactRecord {
  key: string;
  text: string;
  createdAt: string;
  /** Display names of nodes this fact is ABOUT (qualified names / paths). */
  about: string[];
}

/** Cap on recalled facts (spec: keep it small and bounded). */
const MAX_RECALL = 10;

/**
 * Stopwords filtered from both query and fact text before token overlap, so
 * recall matching keys on the meaningful words (same spirit as the
 * duplicate-check's token matching, but text needs the filter a name doesn't).
 */
const TEXT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "has", "have", "how", "i", "in", "is", "it", "its", "of", "on", "or",
  "that", "the", "this", "to", "was", "we", "what", "when", "where",
  "which", "will", "with", "you", "your",
]);

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

/**
 * Recall active MemoryFact nodes.
 *
 * When `about` is given: resolve the name via findByName and return facts
 * with an ABOUT edge to the matched node (the same query shape
 * duplicateCheck.ts uses to surface recorded decisions).
 *
 * When no `about`: token-overlap match against MemoryFact.text — the
 * duplicate-check's name-similarity logic applied to fact text (same
 * nameTokens tokenizer, plus a stopword filter). Sorted by overlap,
 * capped at MAX_RECALL.
 */
export async function recallMemoryFacts(
  client: HydraClient,
  opts: { query?: string; about?: string },
): Promise<MemoryFactRecord[]> {
  let factRows: { key: string; text: string; createdAt: string }[] = [];

  const aboutName = opts.about?.trim() ?? "";
  if (aboutName.length > 0) {
    const matches = await findByName(client, aboutName);
    if (matches.length === 0) {
      throw new Error(
        `Couldn't find anything named "${aboutName}" in the indexed graph — try \`hydracode index\` first, or check the spelling.`,
      );
    }
    const seen = new Set<string>();
    for (const m of matches) {
      const res = await client.query(
        `MATCH (m:${NODE_LABELS.MEMORY_FACT})-[:${REL_TYPES.ABOUT}]->(t:${m.label}) WHERE t.key = $key AND m.status = 'active' RETURN m.key AS k, m.text AS text, m.createdAt AS createdAt`,
        { key: m.key },
        { consistency: "strong" },
      );
      for (const row of res.rows) {
        const cells = rowCells(row);
        const k = cellStr(cells[0]);
        if (k !== "" && !seen.has(k)) {
          seen.add(k);
          factRows.push({ key: k, text: cellStr(cells[1]), createdAt: cellStr(cells[2]) });
        }
      }
    }
  } else {
    const res = await client.query(
      `MATCH (m:${NODE_LABELS.MEMORY_FACT}) WHERE m.status = 'active' RETURN m.key AS k, m.text AS text, m.createdAt AS createdAt`,
      undefined,
      { consistency: "strong" },
    );
    for (const row of res.rows) {
      const cells = rowCells(row);
      const k = cellStr(cells[0]);
      if (k !== "") {
        factRows.push({ key: k, text: cellStr(cells[1]), createdAt: cellStr(cells[2]) });
      }
    }

    const q = opts.query?.trim() ?? "";
    if (q.length > 0) {
      const qTokens = nameTokens(q).filter((t) => !TEXT_STOPWORDS.has(t));
      if (qTokens.length === 0) {
        factRows = [];
      } else {
        factRows = factRows
          .map((f) => {
            const fTokens = new Set(
              nameTokens(f.text).filter((t) => !TEXT_STOPWORDS.has(t)),
            );
            let overlap = 0;
            for (const t of qTokens) if (fTokens.has(t)) overlap++;
            return { fact: f, overlap };
          })
          .filter((s) => s.overlap >= 1)
          .sort((a, b) => b.overlap - a.overlap)
          .slice(0, MAX_RECALL)
          .map((s) => s.fact);
      }
    } else {
      factRows = factRows.slice(0, MAX_RECALL);
    }
  }

  if (factRows.length === 0) return [];

  // ABOUT targets for the returned facts, one label-agnostic query (the
  // MemoryFact side carries the label, so the unlabelled target is legal).
  const targetRes = await client.query(
    `MATCH (m:${NODE_LABELS.MEMORY_FACT})-[:${REL_TYPES.ABOUT}]->(t) RETURN m.key AS mk, t.key AS tk, t.name AS tn, t.path AS tp`,
    undefined,
    { consistency: "strong" },
  );
  const aboutByFact = new Map<string, string[]>();
  for (const row of targetRes.rows) {
    const cells = rowCells(row);
    const mk = cellStr(cells[0]);
    const display = cellStr(cells[2]) || cellStr(cells[3]) || cellStr(cells[1]);
    if (mk === "" || display === "") continue;
    const list = aboutByFact.get(mk) ?? [];
    if (!list.includes(display)) list.push(display);
    aboutByFact.set(mk, list);
  }

  return factRows.map((f) => ({ ...f, about: aboutByFact.get(f.key) ?? [] }));
}

export async function recordKnownDuplicate(
  client: HydraClient,
  proposedName: string,
  reason: string,
  candidates: DuplicateCandidate[],
): Promise<MemoryFactRef> {
  const names = candidates.map((c) => functionNameFromKey(c.key));
  const list =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  const text =
    `Deliberate duplicate: wrote new function "${proposedName}" despite ` +
    `${candidates.length} similar existing function(s) flagged (${list}). ` +
    `Reason: ${reason.trim().length > 0 ? reason.trim() : "not given"}. ` +
    `Recorded via hydracode check-duplicate --record.`;

  return recordMemoryFact(client, {
    text,
    about: candidates.map((c) => ({ key: c.key, label: NODE_LABELS.FUNCTION })),
  });
}
