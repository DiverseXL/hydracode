/**
 * SARIF writer: writes SecurityFinding nodes and AFFECTS edges into HydraDB.
 *
 * Uses the same write patterns as graph/writer.ts (MERGE on id, batch
 * UNWIND, strong consistency) but is a separate module since this is a
 * different ingestion path from the code-graph write flow.
 *
 * AFFECTS edges link findings to:
 * 1. File nodes — always (file-level link as fallback)
 * 2. Function nodes — when the finding's startLine falls within the
 *    function's [startLine, endLine] range in the same file
 */

import ora from "ora";
import type { HydraClient } from "../hydra/client.js";
import type { ParsedFinding } from "../extract/sarifParser.js";
import { hashToVertexId } from "./hashId.js";
import { NODE_LABELS, REL_TYPES } from "./schema.js";

const BATCH_SIZE = 200;

export interface SarifWriteSummary {
  findingsWritten: number;
  affectsFileEdges: number;
  affectsFunctionEdges: number;
  skippedNoLocation: number;
}

/**
 * Write parsed SARIF findings to HydraDB.
 *
 * Step 1: Write SecurityFinding nodes
 * Step 2: AFFECTS edges to File nodes (query File nodes once, match by path)
 * Step 3: AFFECTS edges to Function nodes (match by file + line range)
 */
export async function writeFindings(
  findings: ParsedFinding[],
  client: HydraClient,
  opts?: { quiet?: boolean },
): Promise<SarifWriteSummary> {
  const spinner = opts?.quiet ? undefined : ora({ color: "blue" }).start("writing security findings");

  const summary: SarifWriteSummary = {
    findingsWritten: 0,
    affectsFileEdges: 0,
    affectsFunctionEdges: 0,
    skippedNoLocation: 0,
  };

  if (findings.length === 0) {
    if (spinner) spinner.succeed("no findings to write");
    return summary;
  }

  // ── Step 1: Write SecurityFinding nodes ──────────────────────────
  const findingRows = findings.map((f) => {
    const key = `finding:${f.ruleId}#${f.uri}#${f.startLine}`;
    return {
      id: hashToVertexId(key),
      key,
      ruleId: f.ruleId,
      message: f.message,
      severity: f.severity,
      uri: f.uri,
      startLine: f.startLine,
      endLine: f.endLine,
      tool: f.tool,
    };
  });

  if (spinner) spinner.text = `writing ${findingRows.length} SecurityFinding nodes`;

  const FINDING_BODY = `MERGE (n {id: row.id})\nSET n:${NODE_LABELS.SECURITY_FINDING}, n.key = row.key, n.ruleId = row.ruleId, n.message = row.message, n.severity = row.severity, n.uri = row.uri, n.startLine = row.startLine, n.endLine = row.endLine, n.tool = row.tool`;

  for (let i = 0; i < findingRows.length; i += BATCH_SIZE) {
    const batch = findingRows.slice(i, i + BATCH_SIZE);
    await client.query(
      `UNWIND $rows AS row ${FINDING_BODY}`,
      { rows: batch },
      { consistency: "strong" },
    );
    summary.findingsWritten += batch.length;
  }

  // ── Step 2: Resolve File node ids ────────────────────────────────
  if (spinner) spinner.text = "resolving File nodes for AFFECTS edges";

  const fileRes = await client.query(
    `MATCH (f:${NODE_LABELS.FILE}) RETURN f.id AS id, f.key AS key, f.path AS path`,
    undefined,
    { consistency: "strong" },
  );

  // Build path → id map. File keys look like "file:src/cli.ts"; paths
  // are the unprefixed form. We index by path for lookup.
  const fileIdByPath = new Map<string, number>();
  for (const row of fileRes.rows) {
    const cells = row as unknown[];
    const id = unwrap(cells[0]);
    const key = unwrap(cells[1]);
    const filePath = unwrap(cells[2]);
    if (typeof id === "number" && typeof filePath === "string") {
      fileIdByPath.set(filePath, id);
    } else if (typeof id === "number" && typeof key === "string") {
      // Fallback: strip "file:" prefix from key
      const pathFromKey = key.replace(/^file:/, "");
      fileIdByPath.set(pathFromKey, id);
    }
  }

  // ── Step 3: AFFECTS edges to File nodes ──────────────────────────
  if (spinner) spinner.text = "writing AFFECTS edges to File nodes";

  const fileEdgeRows: { fromId: number; toId: number; edgeId: number; edgeKey: string }[] = [];
  for (const fr of findingRows) {
    const fileId = fileIdByPath.get(fr.uri);
    if (fileId !== undefined) {
      const edgeKey = `${fr.key}->${REL_TYPES.AFFECTS}->file:${fr.uri}`;
      fileEdgeRows.push({
        fromId: fr.id,
        toId: fileId,
        edgeId: hashToVertexId(edgeKey),
        edgeKey,
      });
    }
  }

  const AFFECTS_FILE_BODY = `MATCH (a:${NODE_LABELS.SECURITY_FINDING} {id: row.fromId}), (b:${NODE_LABELS.FILE} {id: row.toId})\nMERGE (a)-[r:${REL_TYPES.AFFECTS} {id: row.edgeId}]->(b)\nSET r.key = row.edgeKey`;

  for (let i = 0; i < fileEdgeRows.length; i += BATCH_SIZE) {
    const batch = fileEdgeRows.slice(i, i + BATCH_SIZE);
    await client.query(
      `UNWIND $rows AS row ${AFFECTS_FILE_BODY}`,
      { rows: batch },
      { consistency: "strong" },
    );
    summary.affectsFileEdges += batch.length;
  }

  // ── Step 4: AFFECTS edges to Function nodes ──────────────────────
  if (spinner) spinner.text = "resolving Function nodes for AFFECTS edges";

  // Collect unique file paths that have findings.
  const filesWithFindings = new Set(findingRows.map((f) => f.uri));

  // Query functions in those files.
  // Since we can't use IN with a list of strings easily, query all functions
  // and filter in JS — the set is small (hundreds, not millions).
  const fnRes = await client.query(
    `MATCH (fn:${NODE_LABELS.FUNCTION}) RETURN fn.id AS id, fn.key AS key, fn.startLine AS startLine, fn.endLine AS endLine`,
    undefined,
    { consistency: "strong" },
  );

  // Build function lookup: path → array of { id, startLine, endLine }
  const functionsByFile = new Map<string, { id: number; startLine: number; endLine: number }[]>();
  for (const row of fnRes.rows) {
    const cells = row as unknown[];
    const id = unwrap(cells[0]);
    const key = unwrap(cells[1]);
    const startLine = unwrap(cells[2]);
    const endLine = unwrap(cells[3]);
    if (typeof id !== "number" || typeof key !== "string") continue;
    if (typeof startLine !== "number" || typeof endLine !== "number") continue;

    // Extract file path from key: "function:src/cli.ts#foo#12" → "src/cli.ts"
    const bare = key.replace(/^function:/, "");
    const filePath = bare.split("#")[0];
    if (filePath === undefined) continue;

    if (!functionsByFile.has(filePath)) {
      functionsByFile.set(filePath, []);
    }
    functionsByFile.get(filePath)!.push({ id, startLine, endLine });
  }

  // Match findings to functions.
  if (spinner) spinner.text = "writing AFFECTS edges to Function nodes";

  const fnEdgeRows: { fromId: number; toId: number; edgeId: number; edgeKey: string }[] = [];
  for (const fr of findingRows) {
    const fns = functionsByFile.get(fr.uri);
    if (fns === undefined) continue;

    for (const fn of fns) {
      // Finding AFFECTS a Function if startLine falls within [fn.startLine, fn.endLine]
      if (fr.startLine >= fn.startLine && fr.startLine <= fn.endLine) {
        const fnKey = `function:${fr.uri}#${fr.ruleId}#${fr.startLine}`; // not ideal, use actual fn key
        // We need the actual function key for the edge, but we only have the id.
        // Use the function id in the edge key instead.
        const edgeKey = `${fr.key}->${REL_TYPES.AFFECTS}->fn:${fn.id}`;
        fnEdgeRows.push({
          fromId: fr.id,
          toId: fn.id,
          edgeId: hashToVertexId(edgeKey),
          edgeKey,
        });
      }
    }
  }

  const AFFECTS_FN_BODY = `MATCH (a:${NODE_LABELS.SECURITY_FINDING} {id: row.fromId}), (b:${NODE_LABELS.FUNCTION} {id: row.toId})\nMERGE (a)-[r:${REL_TYPES.AFFECTS} {id: row.edgeId}]->(b)\nSET r.key = row.edgeKey`;

  for (let i = 0; i < fnEdgeRows.length; i += BATCH_SIZE) {
    const batch = fnEdgeRows.slice(i, i + BATCH_SIZE);
    await client.query(
      `UNWIND $rows AS row ${AFFECTS_FN_BODY}`,
      { rows: batch },
      { consistency: "strong" },
    );
    summary.affectsFunctionEdges += batch.length;
  }

  if (spinner) {
    spinner.succeed(
      `imported ${summary.findingsWritten} findings · ${summary.affectsFileEdges} file edges · ${summary.affectsFunctionEdges} function edges`,
    );
  }

  return summary;
}

/** Unwrap a HydraDB row cell value (handles {type: "string", value: v} etc). */
function unwrap(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const record = v as Record<string, unknown>;
  if (typeof record.type === "string" && "value" in record) {
    return record.value;
  }
  return v;
}
