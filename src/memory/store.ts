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
  /** Optional: key of an older MemoryFact that this fact supersedes. */
  supersedesKey?: string;
}

/* ------------------------- Cypher body templates ------------------------- */

const FACT_BODY = `MERGE (n {id: row.id})
SET n:${NODE_LABELS.MEMORY_FACT}, n.key = row.key, n.text = row.text, n.createdAt = row.createdAt, n.trust = row.trust, n.status = row.status`;

const aboutBody = (targetLabel: NodeLabel): string =>
  `MATCH (a:${NODE_LABELS.MEMORY_FACT} {id: row.fromId}), (b:${targetLabel} {id: row.toId})
MERGE (a)-[r:${REL_TYPES.ABOUT} {id: row.edgeId}]->(b)
SET r.key = row.edgeKey`;

const supersededByBody = `MATCH (old:${NODE_LABELS.MEMORY_FACT} {id: row.oldId}), (new:${NODE_LABELS.MEMORY_FACT} {id: row.newId})
MERGE (old)-[r:${REL_TYPES.SUPERSEDED_BY} {id: row.edgeId}]->(new)
SET r.key = row.edgeKey`;

/* ------------------------------ record ---------------------------------- */

/**
 * Write one MemoryFact node (and optional ABOUT edges) to the graph.
 * Idempotent per fact key: a fresh `memory:<uuid>` key means every call
 * records a distinct fact (this is a log of decisions, not a upsert).
 * 
 * If supersedesKey is provided, the old fact is marked as "superseded" and
 * a SUPERSEDED_BY edge is created from old to new. The old fact must exist.
 */
export async function recordMemoryFact(
  client: HydraClient,
  opts: RecordMemoryFactOptions,
): Promise<{ fact: MemoryFactRef; superseded?: MemoryFactRef }> {
  const createdAt = new Date().toISOString();
  const trust = opts.trust ?? 1;
  const status = opts.status ?? "active";
  const key = `memory:${randomUUID()}`;

  // Resolve the old fact if supersedesKey is provided
  let oldFactData: { key: string; text: string; createdAt: string } | undefined;
  if (opts.supersedesKey) {
    const normalizedOldKey = opts.supersedesKey.startsWith("memory:")
      ? opts.supersedesKey
      : `memory:${opts.supersedesKey}`;
    const res = await client.query(
      `MATCH (m:${NODE_LABELS.MEMORY_FACT} {key: $key}) RETURN m.key AS key, m.text AS text, m.createdAt AS createdAt`,
      { key: normalizedOldKey },
      { consistency: "strong" },
    );
    if (res.rows.length === 0) {
      throw new Error(
        `No MemoryFact found with key "${normalizedOldKey}" — cannot supersede a fact that doesn't exist.`,
      );
    }
    const cells = rowCells(res.rows[0]);
    oldFactData = {
      key: cellStr(cells[0]),
      text: cellStr(cells[1]),
      createdAt: cellStr(cells[2]),
    };
  }

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

  // If supersedesKey was provided, write SUPERSEDED_BY edge and update old fact's status
  if (oldFactData) {
    const oldId = hashToVertexId(oldFactData.key);
    const newId = hashToVertexId(key);
    const edgeKey = `${oldFactData.key}->${REL_TYPES.SUPERSEDED_BY}->${key}`;
    const edgeId = hashToVertexId(edgeKey);

    // Update the old fact's status to "superseded" - use direct MATCH SET without UNWIND
    await client.query(
      `MATCH (m:${NODE_LABELS.MEMORY_FACT} {id: $id})
SET m.status = $status`,
      { id: oldId, status: "superseded" },
      { consistency: "strong" },
    );

    // Write the SUPERSEDED_BY edge (following the same pattern as ABOUT edges)
    await client.query(
      `UNWIND $rows AS row\n${supersededByBody}`,
      {
        rows: [
          {
            oldId,
            newId,
            edgeId,
            edgeKey,
          },
        ],
      },
      { consistency: "strong" },
    );
  }

  return {
    fact: { key, text: opts.text, createdAt },
    superseded: oldFactData,
  };
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
  supersedesKey?: string,
): Promise<{
  recorded: MemoryFactRef;
  superseded?: MemoryFactRef;
  about: { key: string; label: NodeLabel }[];
}> {
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
  const result = await recordMemoryFact(client, { text, about, supersedesKey });
  return { recorded: result.fact, superseded: result.superseded, about };
}

/* ------------------------------ recall ---------------------------------- */

/** One recalled fact, as returned to callers. */
export interface MemoryFactRecord {
  key: string;
  text: string;
  createdAt: string;
  /** Display names of nodes this fact is ABOUT (qualified names / paths). */
  about: string[];
  /** Confidence 0–1; defaults to 1.0. */
  trust: number;
  /** When nearNode is used: whether this fact is directly about the anchor (true) or about a neighborhood node (false). */
  aboutAnchor?: boolean;
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
 * When `nearNode` is given: resolve the anchor via findByName, then find
 * its file + 1-hop call neighborhood via two graph queries (the engine's
 * variable-length MATCH only supports one relationship type per pattern, so
 * CALLS*0..1 and the CONTAINS file lookup are issued separately and merged
 * in memory). Returns all active MemoryFact nodes ABOUT any neighbor.
 *
 * When no `about` or `nearNode`: token-overlap match against MemoryFact.text — the
 * duplicate-check's name-similarity logic applied to fact text (same
 * nameTokens tokenizer, plus a stopword filter). Sorted by overlap,
 * capped at MAX_RECALL.
 *
 * When both `nearNode` AND `query` are provided: proximity is the primary
 * signal, text narrows it further (intersect, not union).
 */
export async function recallMemoryFacts(
  client: HydraClient,
  opts: { query?: string; about?: string; nearNode?: string },
): Promise<MemoryFactRecord[]> {
  let factRows: { key: string; text: string; createdAt: string; trust: number; aboutAnchor?: boolean }[] = [];

  const nearName = opts.nearNode?.trim() ?? "";
  const aboutName = opts.about?.trim() ?? "";

  if (nearName.length > 0) {
    // --- Proximity-based retrieval (nearNode) ---
    const matches = await findByName(client, nearName);
    if (matches.length === 0) {
      throw new Error(
        `No indexed node found named "${nearName}" — run \`hydracode index\` first.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `"${nearName}" matched ${matches.length} nodes (${matches
          .map((m) => m.key)
          .join(", ")}). Be more specific — use the exact function qualified name or file path.`,
      );
    }
    const anchor = matches[0];

    // Step 2: get the anchor's file and call neighborhood.
    // Grammar constraint: variable-length MATCH requires exactly one
    // relationship type per pattern (confirmed: multi-type CALLS|CONTAINS
    // is rejected). Two-query fallback:
    //   Query A: CALLS*0..1 from the anchor (direct callees + anchor itself)
    //   Query B: CONTAINS lookup — which File CONTAINS the anchor
    // The results are merged into one flat set of neighbor ids.
    const neighborIds = new Set<number>();
    const neighborMeta = new Map<number, { key: string; rel: string }>();

    // Include the anchor itself in the neighbor set.
    // NOTE: HydraDB's variable-length MATCH requires *1..N (minimum 1 hop),
    // so CALLS*0..1 is NOT supported — we add the anchor explicitly.
    neighborIds.add(anchor.id);

    // Query A: direct CALLS neighbors (1 hop out from anchor)
    const callsRes = await client.query(
      `MATCH ({id: $anchorId})-[:CALLS*1..1]->(neighbor) RETURN DISTINCT neighbor.id, neighbor.key`,
      { anchorId: anchor.id },
      { consistency: "strong" },
    );
    for (const row of callsRes.rows) {
      const cells = rowCells(row);
      const nid = Number(unwrapValue(cells[0]));
      const nkey = cellStr(cells[1]);
      if (!Number.isNaN(nid) && nkey !== "") {
        neighborIds.add(nid);
        if (nid !== anchor.id) {
          neighborMeta.set(nid, { key: nkey, rel: "CALLS" });
        }
      }
    }

    // Query B: which File CONTAINS this anchor
    const fileRes = await client.query(
      `MATCH (file:${NODE_LABELS.FILE})-[:CONTAINS]->(anchor {id: $anchorId}) RETURN DISTINCT file.id, file.key`,
      { anchorId: anchor.id },
      { consistency: "strong" },
    );
    for (const row of fileRes.rows) {
      const cells = rowCells(row);
      const fid = Number(unwrapValue(cells[0]));
      const fkey = cellStr(cells[1]);
      if (!Number.isNaN(fid) && fkey !== "") {
        neighborIds.add(fid);
        neighborMeta.set(fid, { key: fkey, rel: "CONTAINS" });
      }
    }

    // Step 3: fetch active MemoryFact nodes ABOUT any of those neighbor ids.
    // Grammar constraint: UNWIND MATCH does not support WHERE in HydraDB
    // ("UNWIND MATCH does not support OPTIONAL, hints, or WHERE"), so we
    // cannot use `UNWIND $ids AS nid MATCH (m)-[:ABOUT]->({id: nid})`.
    // Instead, fetch all active facts with their ABOUT edges and filter in
    // JS — the memory graph is small (bounded by MAX_RECALL) so this is
    // efficient.
    const factsRes = await client.query(
      `MATCH (m:${NODE_LABELS.MEMORY_FACT})-[:${REL_TYPES.ABOUT}]->(t)
WHERE m.status = 'active'
RETURN m.key AS mk, m.text AS text, m.createdAt AS createdAt, m.trust AS trust, t.id AS tid, t.key AS tkey`,
      undefined,
      { consistency: "strong" },
    );

    // Deduplicate by fact key, merging aboutKey values into about[]
    const factByKey = new Map<string, { key: string; text: string; createdAt: string; trust: number; aboutKeys: string[]; aboutNids: Set<number> }>();
    for (const row of factsRes.rows) {
      const cells = rowCells(row);
      const k = cellStr(cells[0]);
      const tid = Number(unwrapValue(cells[4]));
      if (k === "") continue;
      // Only include facts whose ABOUT target is in the neighbor set
      if (!neighborIds.has(tid)) continue;
      const existing = factByKey.get(k);
      if (existing) {
        const ak = cellStr(cells[5]);
        if (!existing.aboutKeys.includes(ak)) existing.aboutKeys.push(ak);
        existing.aboutNids.add(tid);
      } else {
        factByKey.set(k, {
          key: k,
          text: cellStr(cells[1]),
          createdAt: cellStr(cells[2]),
          trust: Number(unwrapValue(cells[3])) || 1.0,
          aboutKeys: [cellStr(cells[5])],
          aboutNids: new Set([tid]),
        });
      }
    }

    // Step 4: if query is ALSO provided, post-filter proximity results
    let filteredFacts = [...factByKey.values()];
    const q = opts.query?.trim() ?? "";
    if (q.length > 0) {
      const qTokens = nameTokens(q).filter((t) => !TEXT_STOPWORDS.has(t));
      if (qTokens.length > 0) {
        filteredFacts = filteredFacts
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
          .map((s) => s.fact);
      }
    }

    // Sort by trust DESC then createdAt DESC, cap at MAX_RECALL
    filteredFacts
      .sort((a, b) => b.trust - a.trust || b.createdAt.localeCompare(a.createdAt));
    const limited = filteredFacts.slice(0, MAX_RECALL);

    factRows = limited.map((f) => ({
      key: f.key,
      text: f.text,
      createdAt: f.createdAt,
      trust: f.trust,
      aboutAnchor: f.aboutNids.has(anchor.id),
    }));
  } else if (aboutName.length > 0) {
    const matches = await findByName(client, aboutName);
    if (matches.length === 0) {
      throw new Error(
        `Couldn't find anything named "${aboutName}" in the indexed graph — try \`hydracode index\` first, or check the spelling.`,
      );
    }
    const seen = new Set<string>();
    for (const m of matches) {
      const res = await client.query(
        `MATCH (m:${NODE_LABELS.MEMORY_FACT})-[:${REL_TYPES.ABOUT}]->(t:${m.label}) WHERE t.key = $key AND m.status = 'active' RETURN m.key AS k, m.text AS text, m.createdAt AS createdAt, m.trust AS trust`,
        { key: m.key },
        { consistency: "strong" },
      );
      for (const row of res.rows) {
        const cells = rowCells(row);
        const k = cellStr(cells[0]);
        if (k !== "" && !seen.has(k)) {
          seen.add(k);
          factRows.push({ key: k, text: cellStr(cells[1]), createdAt: cellStr(cells[2]), trust: Number(unwrapValue(cells[3])) || 1.0 });
        }
      }
    }
  } else {
    const res = await client.query(
      `MATCH (m:${NODE_LABELS.MEMORY_FACT}) WHERE m.status = 'active' RETURN m.key AS k, m.text AS text, m.createdAt AS createdAt, m.trust AS trust`,
      undefined,
      { consistency: "strong" },
    );
    for (const row of res.rows) {
      const cells = rowCells(row);
      const k = cellStr(cells[0]);
      if (k !== "") {
        factRows.push({ key: k, text: cellStr(cells[1]), createdAt: cellStr(cells[2]), trust: Number(unwrapValue(cells[3])) || 1.0 });
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

  return factRows.map((f) => ({
    key: f.key,
    text: f.text,
    createdAt: f.createdAt,
    about: aboutByFact.get(f.key) ?? [],
    trust: f.trust,
    aboutAnchor: f.aboutAnchor,
  }));
}

/** One listed memory fact with full details. */
export interface ListedMemoryFact {
  key: string;
  text: string;
  createdAt: string;
  status: MemoryFactStatus;
  trust: number;
  /** keys of nodes this fact is ABOUT (empty array if unlinked) */
  about: string[];
  /** key of the superseding fact, if this one is superseded */
  supersededBy?: string;
}

/**
 * List all MemoryFact nodes, optionally including superseded ones.
 * Groups ABOUT relationships for efficient batched queries.
 */
export async function listMemoryFacts(
	client: HydraClient,
	opts?: { includeSuperseded?: boolean },
): Promise<ListedMemoryFact[]> {
	// Fetch all facts filtered by status
	const statusFilter = opts?.includeSuperseded ? "" : "WHERE m.status = 'active'";
	const res = await client.query(
		`MATCH (m:${NODE_LABELS.MEMORY_FACT}) ${statusFilter} RETURN m.id AS id, m.key AS key, m.text AS text, m.createdAt AS createdAt, m.status AS status, m.trust AS trust ORDER BY m.createdAt DESC`,
		undefined,
		{ consistency: "strong" },
	);

	const facts: ListedMemoryFact[] = [];
	const factKeyById = new Map<string, ListedMemoryFact>();

	for (const row of res.rows) {
		const cells = rowCells(row);
		const id = cellStr(cells[0]);
		const key = cellStr(cells[1]);
		if (key === "" || id === "") continue;

		const fact: ListedMemoryFact = {
			key,
			text: cellStr(cells[2]),
			createdAt: cellStr(cells[3]),
			status: (cellStr(cells[4]) as MemoryFactStatus) || "active",
			trust: Number(unwrapValue(cells[5])) || 1.0,
			about: [],
		};
		facts.push(fact);
		factKeyById.set(id, fact);
	}

	if (facts.length === 0) return [];

	// Fetch all ABOUT targets for all facts in a single query
	const aboutRes = await client.query(
		`MATCH (m:${NODE_LABELS.MEMORY_FACT})-[:${REL_TYPES.ABOUT}]->(t)
RETURN m.id AS factId, t.key AS targetKey`,
		undefined,
		{ consistency: "strong" },
	);

	const aboutByFactId = new Map<string, string[]>();
	for (const row of aboutRes.rows) {
		const cells = rowCells(row);
		const factId = cellStr(cells[0]);
		const targetKey = cellStr(cells[1]);
		if (factId === "" || targetKey === "") continue;
		const list = aboutByFactId.get(factId) ?? [];
		if (!list.includes(targetKey)) list.push(targetKey);
		aboutByFactId.set(factId, list);
	}

	// Assign ABOUT targets to facts
	for (const [factId, aboutList] of aboutByFactId) {
		const fact = factKeyById.get(factId);
		if (fact) fact.about = aboutList;
	}

	// If includeSuperseded, also fetch SUPERSEDED_BY edges
	if (opts?.includeSuperseded) {
		const superRes = await client.query(
			`MATCH (m:${NODE_LABELS.MEMORY_FACT})-[:${REL_TYPES.SUPERSEDED_BY}]->(newer:${NODE_LABELS.MEMORY_FACT})
RETURN m.id AS factId, newer.key AS newerKey`,
			undefined,
			{ consistency: "strong" },
		);

		for (const row of superRes.rows) {
			const cells = rowCells(row);
			const factId = cellStr(cells[0]);
			const newerKey = cellStr(cells[1]);
			if (factId === "" || newerKey === "") continue;
			const fact = factKeyById.get(factId);
			if (fact) fact.supersededBy = newerKey;
		}
	}

	return facts;
}

/**
 * Delete all MemoryFact nodes whose keys are NOT in the keepKeys set.
 * Also detaches ABOUT and SUPERSEDED_BY edges from deleted nodes.
 * Returns the count of facts deleted.
 */
export async function cleanMemoryFacts(
	client: HydraClient,
	keepKeys: string[],
): Promise<number> {
	// Fetch all active MemoryFact keys
	const res = await client.query(
		`MATCH (m:${NODE_LABELS.MEMORY_FACT}) RETURN m.key AS key`,
		undefined,
		{ consistency: "strong" },
	);

	const keepSet = new Set(keepKeys);
	const toDelete: string[] = [];
	for (const row of res.rows) {
		const cells = rowCells(row);
		const key = cellStr(cells[0]);
		if (key !== "" && !keepSet.has(key)) {
			toDelete.push(key);
		}
	}

	if (toDelete.length === 0) return 0;

	// Detach-delete each fact by key using MATCH (HydraDB doesn't support
	// UNWIND with WHERE, so we delete one at a time — the list is small).
	for (const key of toDelete) {
		await client.query(
			`MATCH (m:${NODE_LABELS.MEMORY_FACT} {key: $key}) DETACH DELETE m`,
			{ key },
			{ consistency: "strong" },
		);
	}

	return toDelete.length;
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

  const result = await recordMemoryFact(client, {
    text,
    about: candidates.map((c) => ({ key: c.key, label: NODE_LABELS.FUNCTION })),
  });
  return result.fact;
}
