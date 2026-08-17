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
import type { HydraClient } from "../hydra/client.js";
import type { DuplicateCandidate } from "../graph/duplicateCheck.js";
import { functionNameFromKey } from "../graph/duplicateCheck.js";
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
