/**
 * Graph writer: MERGEs extracted data (src/extract/tsExtractor.ts) into
 * HydraDB, using the schema in graph/schema.ts as the source of truth.
 *
 * WHY NO $param BINDING: HydraDB's OpenCypher subset does not document
 * parameter binding for arrays-of-objects (the natural shape for batched
 * UNWIND writes), and client.query()'s params path deliberately rejects
 * objects for that reason (see src/hydra/client.ts). So this module builds
 * literal Cypher map/list text — every value passed through
 * escapeCypherScalar — and calls client.query(cypherString) with ZERO
 * params. This is intentional, not an oversight; revisit once native
 * parameter binding is confirmed against a running instance.
 *
 * All writes are idempotent MERGEs on the unique keys documented in
 * graph/schema.ts, so re-running `hydracode index` updates existing nodes
 * instead of duplicating them. Batches are chunked at BATCH_SIZE rows per
 * UNWIND to stay within a single query's payload.
 *
 * SET-clause choices (kept consistent across node kinds):
 * - File.lastIndexedAt is mutable (updates on every re-index) -> ON CREATE
 *   and ON MATCH SET. File.language is static per path -> ON CREATE only.
 * - Function/ClassEntity/Test properties are static per unique key (the id
 *   encodes file + name + line, so an edit yields a NEW node) -> ON CREATE
 *   SET only, no ON MATCH.
 * - Module has no mutable properties -> plain MERGE, no SET.
 * - Edges have no properties -> plain MERGE, no SET.
 */

import ora from "ora";
import type { ExtractedFile } from "../extract/tsExtractor.js";
import type { HydraClient } from "../hydra/client.js";
import { escapeCypherScalar } from "../hydra/client.js";
import { NODE_LABELS, REL_TYPES } from "./schema.js";
import type { ClassNode, FunctionNode } from "./schema.js";

/** Max rows per UNWIND batch; larger inputs are chunked into sequential queries. */
export const BATCH_SIZE = 200;

export interface WriteSummary {
  filesWritten: number;
  modulesWritten: number;
  functionsWritten: number;
  classesWritten: number;
  testsWritten: number;
  containsEdges: number;
  importsEdges: number;
  methodOfEdges: number;
  extendsEdges: number;
  /** EXTENDS rows skipped: parent name had zero or multiple class matches. */
  extendsUnresolved: number;
  callsEdgesResolved: number;
  /** CALLS rows skipped: no function with that name in the batch (external/builtin). */
  callsEdgesUnresolved: number;
  /** CALLS rows skipped: multiple candidates, no same-file/same-class winner. */
  callsEdgesAmbiguous: number;
}

/* ------------------------- Cypher body templates ------------------------- */
/* Each is the part after `UNWIND <list> AS row`, using `row.<field>`. */

const FILE_BODY = `MERGE (f:${NODE_LABELS.FILE} {path: row.path})
ON CREATE SET f.language = row.language, f.lastIndexedAt = row.lastIndexedAt
ON MATCH SET f.lastIndexedAt = row.lastIndexedAt`;

const MODULE_BODY = `MERGE (m:${NODE_LABELS.MODULE} {path: row.path})`;

const FUNCTION_BODY = `MERGE (fn:${NODE_LABELS.FUNCTION} {id: row.id})
ON CREATE SET fn.name = row.name, fn.qualifiedName = row.qualifiedName, fn.exported = row.exported, fn.async = row.async, fn.startLine = row.startLine, fn.endLine = row.endLine`;

const CLASS_BODY = `MERGE (c:${NODE_LABELS.CLASS} {id: row.id})
ON CREATE SET c.name = row.name, c.exported = row.exported, c.startLine = row.startLine, c.endLine = row.endLine`;

const TEST_BODY = `MERGE (t:${NODE_LABELS.TEST} {id: row.id})
ON CREATE SET t.name = row.name, t.filePath = row.filePath, t.startLine = row.startLine`;

const containsBody = (targetLabel: string): string =>
  `MATCH (f:${NODE_LABELS.FILE} {path: row.filePath}), (t:${targetLabel} {id: row.targetId})
MERGE (f)-[:${REL_TYPES.CONTAINS}]->(t)`;

const IMPORTS_BODY = `MATCH (f:${NODE_LABELS.FILE} {path: row.filePath}), (m:${NODE_LABELS.MODULE} {path: row.modulePath})
MERGE (f)-[:${REL_TYPES.IMPORTS}]->(m)`;

const METHOD_OF_BODY = `MATCH (fn:${NODE_LABELS.FUNCTION} {id: row.functionId}), (c:${NODE_LABELS.CLASS} {id: row.classId})
MERGE (fn)-[:${REL_TYPES.METHOD_OF}]->(c)`;

const EXTENDS_BODY = `MATCH (c:${NODE_LABELS.CLASS} {id: row.classId}), (p:${NODE_LABELS.CLASS} {id: row.parentClassId})
MERGE (c)-[:${REL_TYPES.EXTENDS}]->(p)`;

const CALLS_BODY = `MATCH (a:${NODE_LABELS.FUNCTION} {id: row.callerId}), (b:${NODE_LABELS.FUNCTION} {id: row.calleeId})
MERGE (a)-[:${REL_TYPES.CALLS}]->(b)`;

/* --------------------------- Cypher builders ---------------------------- */

/**
 * Build a Cypher map literal like `{path: "a.ts", language: "typescript"}`
 * for one row, escaping every value with escapeCypherScalar. undefined
 * values are skipped. Fails loudly if any value is an object or an
 * array-of-objects — every node/rel property in this schema is a flat
 * scalar, so this should never trigger.
 */
export function toCypherMap(row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== null && typeof item === "object") {
            throw new Error(
              `toCypherMap: property "${key}" contains an object inside an array — only flat scalars (strings, numbers, booleans, null, arrays of those) are supported.`,
            );
          }
        }
      } else {
        throw new Error(
          `toCypherMap: property "${key}" is an object — only flat scalars are supported in this schema.`,
        );
      }
    }
    parts.push(`${key}: ${escapeCypherScalar(value)}`);
  }
  return `{${parts.join(", ")}}`;
}

/** Join rows into a Cypher list literal: `[{...}, {...}, ...]`. */
export function toCypherList(rows: Record<string, unknown>[]): string {
  return `[${rows.map(toCypherMap).join(", ")}]`;
}

/**
 * Run one batched UNWIND write for `rows`. Chunks internally at BATCH_SIZE
 * and issues sequential query() calls, so callers never need to chunk.
 */
async function writeRows(
  client: HydraClient,
  rows: Record<string, unknown>[],
  body: string,
  quiet: boolean,
  label: string,
): Promise<void> {
  if (rows.length === 0) return;
  const spinner = quiet ? undefined : ora(label).start();
  try {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      const cypher = `UNWIND ${toCypherList(chunk)} AS row\n${body}`;
      await client.query(cypher);
      if (spinner) {
        spinner.text = `${label} (${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length})`;
      }
    }
  } finally {
    spinner?.stop();
  }
}

/* ------------------------------ resolution ------------------------------ */

/**
 * Resolve EXTENDS parent names to ClassNode ids, in-memory against this
 * batch only (never querying HydraDB): prefer a class in the child's own
 * file, then a unique name match across all extracted classes. Zero or
 * multiple matches -> skipped and tallied.
 */
function resolveExtends(
  files: ExtractedFile[],
): { extendsRows: Record<string, unknown>[]; extendsUnresolved: number } {
  const classIdToFile = new Map<string, string>();
  const classesByName = new Map<string, ClassNode[]>();
  const classesByFileAndName = new Map<string, Map<string, ClassNode>>();

  for (const f of files) {
    const byName = classesByFileAndName.get(f.file.path) ?? new Map();
    for (const c of f.classes) {
      classIdToFile.set(c.id, f.file.path);
      byName.set(c.name, c);
      const list = classesByName.get(c.name) ?? [];
      list.push(c);
      classesByName.set(c.name, list);
    }
    classesByFileAndName.set(f.file.path, byName);
  }

  const extendsRows: Record<string, unknown>[] = [];
  let extendsUnresolved = 0;

  for (const f of files) {
    for (const entry of f.extends) {
      const childFile = classIdToFile.get(entry.classId);
      const sameFile = childFile
        ? classesByFileAndName.get(childFile)?.get(entry.parentClassName)
        : undefined;
      if (sameFile) {
        extendsRows.push({ classId: entry.classId, parentClassId: sameFile.id });
        continue;
      }
      const global = classesByName.get(entry.parentClassName) ?? [];
      if (global.length === 1) {
        extendsRows.push({ classId: entry.classId, parentClassId: global[0].id });
      } else {
        extendsUnresolved++;
      }
    }
  }

  return { extendsRows, extendsUnresolved };
}

/**
 * Resolve CALLS callee names to FunctionNode ids, in-memory against this
 * batch only. Priority per call:
 *   a. kind "this" -> a method of the caller's own class (via METHOD_OF)
 *      whose name matches; else fall through.
 *   b. a function in the caller's own file whose name matches.
 *   c. a UNIQUE name match across the whole batch.
 * Zero candidates -> unresolved (external/builtin — expected). Multiple
 * candidates at the reached tier -> ambiguous, skipped (never guess).
 */
function resolveCalls(
  files: ExtractedFile[],
): {
  callsRows: Record<string, unknown>[];
  resolved: number;
  unresolved: number;
  ambiguous: number;
} {
  const functionsById = new Map<string, FunctionNode>();
  const functionsByFileAndName = new Map<string, Map<string, FunctionNode[]>>();
  const functionsByName = new Map<string, FunctionNode[]>();
  const classByFunctionId = new Map<string, string>();
  const functionsByClass = new Map<string, FunctionNode[]>();

  for (const f of files) {
    const byName = functionsByFileAndName.get(f.file.path) ?? new Map();
    for (const fn of f.functions) {
      functionsById.set(fn.id, fn);
      const fileList = byName.get(fn.name) ?? [];
      fileList.push(fn);
      byName.set(fn.name, fileList);
      const globalList = functionsByName.get(fn.name) ?? [];
      globalList.push(fn);
      functionsByName.set(fn.name, globalList);
    }
    functionsByFileAndName.set(f.file.path, byName);

    for (const m of f.methodOf) {
      classByFunctionId.set(m.functionId, m.classId);
      const fn = functionsById.get(m.functionId);
      if (fn) {
        const classList = functionsByClass.get(m.classId) ?? [];
        classList.push(fn);
        functionsByClass.set(m.classId, classList);
      }
    }
  }

  const callsRows: Record<string, unknown>[] = [];
  let resolved = 0;
  let unresolved = 0;
  let ambiguous = 0;

  for (const f of files) {
    for (const call of f.calls) {
      let targetId: string | undefined;
      let state: "resolved" | "unresolved" | "ambiguous" = "unresolved";

      // Tier a: this.foo() -> method of the caller's own class.
      if (call.kind === "this") {
        const classId = classByFunctionId.get(call.callerId);
        const classMatches = classId
          ? (functionsByClass.get(classId) ?? []).filter(
              (fn) => fn.name === call.calleeName,
            )
          : [];
        if (classMatches.length === 1) {
          targetId = classMatches[0].id;
          state = "resolved";
        } else if (classMatches.length > 1) {
          state = "ambiguous";
        }
      }

      // Tier b: same file as the caller.
      if (state !== "resolved" && state !== "ambiguous") {
        const sameFile =
          functionsByFileAndName.get(f.file.path)?.get(call.calleeName) ?? [];
        if (sameFile.length === 1) {
          targetId = sameFile[0].id;
          state = "resolved";
        } else if (sameFile.length > 1) {
          state = "ambiguous";
        }
      }

      // Tier c: unique match across the whole batch.
      if (state !== "resolved" && state !== "ambiguous") {
        const global = functionsByName.get(call.calleeName) ?? [];
        if (global.length === 1) {
          targetId = global[0].id;
          state = "resolved";
        } else if (global.length === 0) {
          state = "unresolved";
        } else {
          state = "ambiguous";
        }
      }

      if (state === "resolved") {
        resolved++;
        if (targetId) {
          callsRows.push({ callerId: call.callerId, calleeId: targetId });
        }
      } else if (state === "ambiguous") {
        ambiguous++;
      } else {
        unresolved++;
      }
    }
  }

  return { callsRows, resolved, unresolved, ambiguous };
}

/* ------------------------------ main export ----------------------------- */

/**
 * Write every extracted file (and its nodes/edges) to HydraDB, in the
 * documented order: nodes first, then edges. Each step is idempotent
 * (MERGE on unique keys) and batched via UNWIND.
 */
export async function writeExtractedFiles(
  files: ExtractedFile[],
  client: HydraClient,
  opts?: { quiet?: boolean },
): Promise<WriteSummary> {
  const quiet = opts?.quiet ?? false;

  const summary: WriteSummary = {
    filesWritten: 0,
    modulesWritten: 0,
    functionsWritten: 0,
    classesWritten: 0,
    testsWritten: 0,
    containsEdges: 0,
    importsEdges: 0,
    methodOfEdges: 0,
    extendsEdges: 0,
    extendsUnresolved: 0,
    callsEdgesResolved: 0,
    callsEdgesUnresolved: 0,
    callsEdgesAmbiguous: 0,
  };

  // 1. File nodes
  const fileRows = files.map((f) => ({
    path: f.file.path,
    language: f.file.language,
    lastIndexedAt: f.file.lastIndexedAt,
  }));
  summary.filesWritten = fileRows.length;
  await writeRows(client, fileRows, FILE_BODY, quiet, "writing File nodes");

  // 2. Module nodes — dedupe by path across all files in-memory first.
  const modulePaths = new Set<string>();
  for (const f of files) {
    for (const imp of f.imports) modulePaths.add(imp.modulePath);
  }
  const moduleRows = [...modulePaths].map((p) => ({ path: p }));
  summary.modulesWritten = moduleRows.length;
  await writeRows(client, moduleRows, MODULE_BODY, quiet, "writing Module nodes");

  // 3. Function nodes
  const functionRows = files.flatMap((f) =>
    f.functions.map((fn) => ({
      id: fn.id,
      name: fn.name,
      qualifiedName: fn.qualifiedName,
      exported: fn.exported,
      async: fn.async,
      startLine: fn.startLine,
      endLine: fn.endLine,
    })),
  );
  summary.functionsWritten = functionRows.length;
  await writeRows(client, functionRows, FUNCTION_BODY, quiet, "writing Function nodes");

  // 4. Class nodes
  const classRows = files.flatMap((f) =>
    f.classes.map((c) => ({
      id: c.id,
      name: c.name,
      exported: c.exported,
      startLine: c.startLine,
      endLine: c.endLine,
    })),
  );
  summary.classesWritten = classRows.length;
  await writeRows(client, classRows, CLASS_BODY, quiet, "writing ClassEntity nodes");

  // 5. Test nodes
  const testRows = files.flatMap((f) =>
    f.tests.map((t) => ({
      id: t.id,
      name: t.name,
      filePath: t.filePath,
      startLine: t.startLine,
    })),
  );
  summary.testsWritten = testRows.length;
  await writeRows(client, testRows, TEST_BODY, quiet, "writing Test nodes");

  // 6. CONTAINS edges — one UNWIND per target label.
  const containsFunctionRows = files.flatMap((f) =>
    f.functions.map((fn) => ({ filePath: f.file.path, targetId: fn.id })),
  );
  const containsClassRows = files.flatMap((f) =>
    f.classes.map((c) => ({ filePath: f.file.path, targetId: c.id })),
  );
  const containsTestRows = files.flatMap((f) =>
    f.tests.map((t) => ({ filePath: f.file.path, targetId: t.id })),
  );
  summary.containsEdges =
    containsFunctionRows.length + containsClassRows.length + containsTestRows.length;
  await writeRows(
    client,
    containsFunctionRows,
    containsBody(NODE_LABELS.FUNCTION),
    quiet,
    "writing CONTAINS (Function) edges",
  );
  await writeRows(
    client,
    containsClassRows,
    containsBody(NODE_LABELS.CLASS),
    quiet,
    "writing CONTAINS (ClassEntity) edges",
  );
  await writeRows(
    client,
    containsTestRows,
    containsBody(NODE_LABELS.TEST),
    quiet,
    "writing CONTAINS (Test) edges",
  );

  // 7. IMPORTS edges — File -> Module, matched by path.
  const importsRows = files.flatMap((f) =>
    f.imports.map((imp) => ({
      filePath: f.file.path,
      modulePath: imp.modulePath,
    })),
  );
  summary.importsEdges = importsRows.length;
  await writeRows(client, importsRows, IMPORTS_BODY, quiet, "writing IMPORTS edges");

  // 8. METHOD_OF edges — Function -> ClassEntity, matched by id.
  const methodOfRows = files.flatMap((f) =>
    f.methodOf.map((m) => ({ functionId: m.functionId, classId: m.classId })),
  );
  summary.methodOfEdges = methodOfRows.length;
  await writeRows(client, methodOfRows, METHOD_OF_BODY, quiet, "writing METHOD_OF edges");

  // 9. EXTENDS edges — resolve parent names in-memory, then write.
  const { extendsRows, extendsUnresolved } = resolveExtends(files);
  summary.extendsEdges = extendsRows.length;
  summary.extendsUnresolved = extendsUnresolved;
  await writeRows(client, extendsRows, EXTENDS_BODY, quiet, "writing EXTENDS edges");

  // 10. CALLS edges — resolve callee names in-memory, then write.
  const { callsRows, resolved, unresolved, ambiguous } = resolveCalls(files);
  summary.callsEdgesResolved = resolved;
  summary.callsEdgesUnresolved = unresolved;
  summary.callsEdgesAmbiguous = ambiguous;
  await writeRows(client, callsRows, CALLS_BODY, quiet, "writing CALLS edges");

  return summary;
}
