/**
 * Graph writer: MERGEs extracted data (src/extract/tsExtractor.ts) into
 * HydraDB, using the schema in graph/schema.ts as the source of truth.
 *
 * WRITE SHAPE (confirmed against a live HydraDB instance and its source,
 * src/query/opencypher.rs + src/client/http.rs):
 * - Rows travel as the `$rows` parameter (a list of maps) in the request
 *   body's `parameters` field, as plain nested JSON. Inline list literals
 *   are rejected by HydraDB's parser, so nothing is inlined.
 * - MERGE identity is GLOBAL and matched by `id` alone: the pattern is
 *   `MERGE (n {id: ...})` with no label filter and no other properties
 *   (extra properties in the pattern are rejected). The label and all
 *   other properties are applied afterward via a single SET clause.
 * - IDs ARE INTEGERS (confirmed engine constraint): vertex/relationship
 *   ids must be non-negative integers, never strings. Every row's `id` is
 *   hashToVertexId(logicalKey) (graph/hashId.ts, deterministic so MERGE
 *   stays idempotent), and the human-readable logical key is stored as the
 *   node's `key` property — an integer id alone is not queryable by
 *   humans.
 * - ON CREATE / ON MATCH are not supported, so every write is one
 *   unconditional SET after MERGE. This is safe because our logical keys
 *   encode file + name + line: an edited function/class/test produces a
 *   genuinely new key (and thus new hashed id) rather than needing
 *   conditional set logic. File.lastIndexedAt updates on every write, even
 *   for unchanged files — accepted behavior, a deliberate simplification
 *   forced by the engine's lack of ON MATCH.
 * - Relationships carry their own deterministic integer `id` (the engine
 *   requires a relationship id for MERGE):
 *   hashToVertexId(`${fromKey}->${REL_TYPE}->${toKey}`) over the LOGICAL
 *   keys — the same logical edge always yields the same id, so MERGE is
 *   idempotent. Edges ALSO store the deterministic string form as a `key`
 *   property (r.key = "${fromKey}->${REL_TYPE}->${toKey}") for
 *   debugging/readability — relationships carry arbitrary scalar
 *   properties beyond id, same as vertices (cypher-compat.md MERGE+SET
 *   example; unwind_relationship_set_fields). The 4-clause
 *   `UNWIND MATCH ... MERGE ... SET` form is explicitly supported.
 * - Edge batches MATCH their endpoints with labels
 *   (`MATCH (a:File {id: row.fromId}), (b:Function {id: row.toId})`): the
 *   UNWIND batch grammar requires exactly one label per endpoint and only
 *   the `id` property. A 3-clause `UNWIND MATCH ... MERGE` (no SET) is
 *   valid; no trailing RETURN is needed.
 *
 * All writes are idempotent MERGEs, so re-running `hydracode index`
 * updates existing nodes instead of duplicating them. Batches are chunked
 * at BATCH_SIZE rows per UNWIND, and writes use strong consistency so each
 * batch immediately sees nodes written by earlier batches (edge batches
 * MATCH their endpoints, which were written in the node phases).
 */

import ora from "ora";
import type { ExtractedFile } from "../extract/tsExtractor.js";
import { unwrapValue } from "../hydra/client.js";
import type { HydraClient } from "../hydra/client.js";
import { hashToVertexId } from "./hashId.js";
import { NODE_LABELS, REL_TYPES } from "./schema.js";
import type {
  ClassNode,
  FunctionNode,
  NodeLabel,
  RelType,
} from "./schema.js";

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
  /** Stale Function/Class/Test nodes removed from re-indexed files (see gcStaleNodes). */
  staleNodesRemoved: number;
}

/* -------------------- type-prefixed LOGICAL keys ------------------------ */
/* HydraDB's MERGE matches on `id` alone across ALL node types (no label
 * filter), so every node is identified by a type-prefixed LOGICAL KEY per
 * graph/schema.ts (keeps the logical space collision-free across types) —
 * but the ENGINE id must be an integer (strings are rejected), so each row
 * computes `id = hashToVertexId(logicalKey)` and stores the logical key as
 * the node's `key` property. The extractor still emits unprefixed keys;
 * the prefix is applied here. Helpers are idempotent so they keep working
 * if the extractor later emits prefixed keys directly. */

function prefixedId(prefix: string, value: string): string {
  return value.startsWith(`${prefix}:`) ? value : `${prefix}:${value}`;
}

const fileId = (repoPath: string): string => prefixedId("file", repoPath);
const moduleId = (modulePath: string): string => prefixedId("module", modulePath);
const functionId = (id: string): string => prefixedId("function", id);
const classId = (id: string): string => prefixedId("class", id);
const testId = (id: string): string => prefixedId("test", id);

/**
 * Deterministic relationship identity from a logical edge. The same
 * (fromKey, relType, toKey) triple always yields the same integer `id` (so
 * MERGE is idempotent) and the same human-readable string `key` (stored as
 * a relationship property for debugging).
 */
const edgePair = (fromKey: string, relType: RelType, toKey: string): { edgeId: number; edgeKey: string } => {
  const edgeKey = `${fromKey}->${relType}->${toKey}`;
  return { edgeId: hashToVertexId(edgeKey), edgeKey };
};

/* ------------------------- Cypher body templates ------------------------- */
/* Each is the part after `UNWIND $rows AS row`, using `row.<field>`.
 * Labels are interpolated from NODE_LABELS/REL_TYPES constants (fixed
 * schema strings we control, never user input). Node bodies MERGE by id
 * only and apply label + properties with one unconditional SET. */

const FILE_BODY = `MERGE (n {id: row.id})
SET n:${NODE_LABELS.FILE}, n.key = row.key, n.path = row.path, n.language = row.language, n.lastIndexedAt = row.lastIndexedAt`;

const MODULE_BODY = `MERGE (n {id: row.id})
SET n:${NODE_LABELS.MODULE}, n.key = row.key, n.path = row.path`;

const FUNCTION_BODY = `MERGE (n {id: row.id})
SET n:${NODE_LABELS.FUNCTION}, n.key = row.key, n.name = row.name, n.qualifiedName = row.qualifiedName, n.exported = row.exported, n.async = row.async, n.startLine = row.startLine, n.endLine = row.endLine`;

const CLASS_BODY = `MERGE (n {id: row.id})
SET n:${NODE_LABELS.CLASS}, n.key = row.key, n.name = row.name, n.exported = row.exported, n.startLine = row.startLine, n.endLine = row.endLine`;

const TEST_BODY = `MERGE (n {id: row.id})
SET n:${NODE_LABELS.TEST}, n.key = row.key, n.name = row.name, n.filePath = row.filePath, n.startLine = row.startLine`;

// Edge bodies: MATCH endpoints by hashed integer id, MERGE the relationship
// on its own hashed integer id, then store the readable string edge key as a
// property. Relationship ids are a DISTINCT namespace from vertex ids per
// HydraDB's type system (RelationshipId vs VertexId, both u64, scoped by
// relationship type) — reusing hashToVertexId for both is safe.
const containsBody = (targetLabel: NodeLabel): string =>
  `MATCH (a:${NODE_LABELS.FILE} {id: row.fromId}), (b:${targetLabel} {id: row.toId})
MERGE (a)-[r:${REL_TYPES.CONTAINS} {id: row.edgeId}]->(b)
SET r.key = row.edgeKey`;

const IMPORTS_BODY = `MATCH (a:${NODE_LABELS.FILE} {id: row.fromId}), (b:${NODE_LABELS.MODULE} {id: row.toId})
MERGE (a)-[r:${REL_TYPES.IMPORTS} {id: row.edgeId}]->(b)
SET r.key = row.edgeKey`;

const METHOD_OF_BODY = `MATCH (a:${NODE_LABELS.FUNCTION} {id: row.fromId}), (b:${NODE_LABELS.CLASS} {id: row.toId})
MERGE (a)-[r:${REL_TYPES.METHOD_OF} {id: row.edgeId}]->(b)
SET r.key = row.edgeKey`;

const EXTENDS_BODY = `MATCH (a:${NODE_LABELS.CLASS} {id: row.fromId}), (b:${NODE_LABELS.CLASS} {id: row.toId})
MERGE (a)-[r:${REL_TYPES.EXTENDS} {id: row.edgeId}]->(b)
SET r.key = row.edgeKey`;

const CALLS_BODY = `MATCH (a:${NODE_LABELS.FUNCTION} {id: row.fromId}), (b:${NODE_LABELS.FUNCTION} {id: row.toId})
MERGE (a)-[r:${REL_TYPES.CALLS} {id: row.edgeId}]->(b)
SET r.key = row.edgeKey`;

// GC: DETACH DELETE removes the stale node and, as a side effect, every
// edge pointing at it (CALLS/METHOD_OF/CONTAINS) — no label needed in the
// MATCH pattern (per cypher-compat.md's working example).
const GC_DELETE_BODY = `MATCH (n {id: row.id}) DETACH DELETE n`;

/* --------------------------- Cypher builders ---------------------------- */

/**
 * Run one batched UNWIND write for `rows`. Chunks internally at BATCH_SIZE
 * and issues sequential query() calls, so callers never need to chunk. Each
 * chunk is passed as the `$rows` parameter (plain nested JSON) — never
 * inlined. Strong consistency so later batches immediately see earlier
 * batches' writes.
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
      const cypher = `UNWIND $rows AS row\n${body}`;
      await client.query(cypher, { rows: chunk }, { consistency: "strong" });
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
 *   b. kind "member" WITH calleeClassHint -> a Function matching `name` AND
 *      methodOf a ClassEntity whose `name` matches calleeClassHint across the
 *      whole batch. Exactly 1 match -> resolved; >1 -> ambiguous; 0 -> unresolved.
 *   c. kind "member" WITHOUT calleeClassHint -> same-file name match, then
 *      unique-name-in-batch (same fallback chain as plain).
 *   d. kind "plain" -> same-file name match, then unique-name-in-batch.
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
  const classNameByClassId = new Map<string, string>();
  const functionsByClassNameAndMethod = new Map<string, Map<string, FunctionNode[]>>();

  for (const f of files) {
    for (const c of f.classes) {
      classNameByClassId.set(c.id, c.name);
    }
  }

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

        const className = classNameByClassId.get(m.classId);
        if (className) {
          let classMethods = functionsByClassNameAndMethod.get(className);
          if (!classMethods) {
            classMethods = new Map();
            functionsByClassNameAndMethod.set(className, classMethods);
          }
          let methodList = classMethods.get(fn.name);
          if (!methodList) {
            methodList = [];
            classMethods.set(fn.name, methodList);
          }
          methodList.push(fn);
        }
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

      // Tier b: kind "member" WITH calleeClassHint -> look for a Function with
      // matching `name` AND methodOf a ClassEntity whose `name` matches calleeClassHint,
      // searched across the whole batch.
      if (
        state !== "resolved" &&
        state !== "ambiguous" &&
        call.kind === "member" &&
        call.calleeClassHint
      ) {
        const hintMatches =
          functionsByClassNameAndMethod
            .get(call.calleeClassHint)
            ?.get(call.calleeName) ?? [];
        if (hintMatches.length === 1) {
          targetId = hintMatches[0].id;
          state = "resolved";
        } else if (hintMatches.length > 1) {
          state = "ambiguous";
        } else {
          state = "unresolved";
        }
      }

      // Tier c & d: kind "member" WITHOUT calleeClassHint, or kind "plain"
      // (Also fallback for "this" if caller is not in a class or method not found).
      // Step 1: same file as the caller.
      if (
        state !== "resolved" &&
        state !== "ambiguous" &&
        !(call.kind === "member" && call.calleeClassHint)
      ) {
        const sameFile =
          functionsByFileAndName.get(f.file.path)?.get(call.calleeName) ?? [];
        if (sameFile.length === 1) {
          targetId = sameFile[0].id;
          state = "resolved";
        } else if (sameFile.length > 1) {
          state = "ambiguous";
        }
      }

      // Step 2: unique match across the whole batch.
      if (
        state !== "resolved" &&
        state !== "ambiguous" &&
        !(call.kind === "member" && call.calleeClassHint)
      ) {
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

/* ------------------------------- garbage collection ---------------------- */

/**
 * Garbage-collect stale Function/Class/Test nodes left behind by earlier
 * indexing runs after source edits.
 *
 * WHY: a function/class/test id encodes startLine, so an edit shifts the
 * line and produces a NEW hashed id (intentional — see schema.ts: "an
 * edited function is a new fact"). The old node version stays behind as an
 * orphan, still holding its old CONTAINS/CALLS/METHOD_OF edges, and would
 * accumulate across edit-reindex cycles and surface as noise in queries.
 *
 * SCOPE: per-file, ONLY for files in this run's `files`. For each file we
 * query HydraDB for the node ids currently CONTAINS-linked to that File
 * node, and diff against the ids this run just wrote for it; anything left
 * over is stale and gets DETACH-DELETEd (which removes its edges too).
 * Files outside this run are never touched, so future partial/single-file
 * indexing stays safe.
 *
 * KNOWN GAP (documented): a file deleted from disk entirely is NOT in
 * `files`, so its old nodes are not covered here. Detecting that requires
 * comparing against previously-recorded state (a separate reconciliation
 * feature), out of scope for now.
 *
 * READ MECHANISM NOTE: per-file scalar reads (`MATCH (f:File {id: $fileId})
 * -[:CONTAINS]->(n) RETURN n.id`) are used instead of the engine's $rows
 * batch-read form, because that form rejects labels on batch patterns
 * ("UNWIND batch node patterns do not support labels") and mandates a
 * source-field projection our node properties don't carry (verified live).
 */
async function gcStaleNodes(
  client: HydraClient,
  files: ExtractedFile[],
  quiet: boolean,
): Promise<number> {
  const staleIds = new Set<number>();
  for (const f of files) {
    const fileHash = hashToVertexId(fileId(f.file.path));
    const written = new Set<number>();
    for (const fn of f.functions) written.add(hashToVertexId(functionId(fn.id)));
    for (const c of f.classes) written.add(hashToVertexId(classId(c.id)));
    for (const t of f.tests) written.add(hashToVertexId(testId(t.id)));

    // Strong consistency: must see the node/edge writes from THIS run.
    const result = await client.query(
      "MATCH (f:File {id: $fileId})-[:CONTAINS]->(n) RETURN n.id AS id",
      { fileId: fileHash },
      { consistency: "strong" },
    );
    for (const row of result.rows) {
      const id = unwrapValue((row as unknown[])[0]);
      if (typeof id === "number" && !written.has(id)) staleIds.add(id);
    }
  }
  if (staleIds.size === 0) return 0;

  const staleRows = [...staleIds].map((id) => ({ id }));
  await writeRows(
    client,
    staleRows,
    GC_DELETE_BODY,
    quiet,
    `removing ${staleIds.size} stale node(s) from re-indexed files`,
  );
  return staleIds.size;
}

/* ------------------------------ main export ----------------------------- */

/**
 * Write every extracted file (and its nodes/edges) to HydraDB, in the
 * documented order: nodes first, then edges. Each step is idempotent
 * (MERGE on global, type-prefixed unique keys) and batched via UNWIND.
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
    staleNodesRemoved: 0,
  };

  // 1. File nodes — id = hash of the logical key ("file:<path>"); the
  //    logical key is stored as `key`, and the unprefixed repo-relative
  //    path as `path` for display/querying.
  const fileRows = files.map((f) => {
    const key = fileId(f.file.path);
    return {
      id: hashToVertexId(key),
      key,
      path: f.file.path,
      language: f.file.language,
      lastIndexedAt: f.file.lastIndexedAt,
    };
  });
  summary.filesWritten = fileRows.length;
  await writeRows(client, fileRows, FILE_BODY, quiet, "writing File nodes");

  // 2. Module nodes — dedupe by path across all files in-memory first.
  const modulePaths = new Set<string>();
  for (const f of files) {
    for (const imp of f.imports) modulePaths.add(imp.modulePath);
  }
  const moduleRows = [...modulePaths].map((p) => {
    const key = moduleId(p);
    return { id: hashToVertexId(key), key, path: p };
  });
  summary.modulesWritten = moduleRows.length;
  await writeRows(client, moduleRows, MODULE_BODY, quiet, "writing Module nodes");

  // 3. Function nodes — extractor id is already `<filePath>#<qualifiedName>#<startLine>`.
  const functionRows = files.flatMap((f) =>
    f.functions.map((fn) => {
      const key = functionId(fn.id);
      return {
        id: hashToVertexId(key),
        key,
        name: fn.name,
        qualifiedName: fn.qualifiedName,
        exported: fn.exported,
        async: fn.async,
        startLine: fn.startLine,
        endLine: fn.endLine,
      };
    }),
  );
  summary.functionsWritten = functionRows.length;
  await writeRows(client, functionRows, FUNCTION_BODY, quiet, "writing Function nodes");

  // 4. Class nodes
  const classRows = files.flatMap((f) =>
    f.classes.map((c) => {
      const key = classId(c.id);
      return {
        id: hashToVertexId(key),
        key,
        name: c.name,
        exported: c.exported,
        startLine: c.startLine,
        endLine: c.endLine,
      };
    }),
  );
  summary.classesWritten = classRows.length;
  await writeRows(client, classRows, CLASS_BODY, quiet, "writing ClassEntity nodes");

  // 5. Test nodes
  const testRows = files.flatMap((f) =>
    f.tests.map((t) => {
      const key = testId(t.id);
      return {
        id: hashToVertexId(key),
        key,
        name: t.name,
        filePath: t.filePath,
        startLine: t.startLine,
      };
    }),
  );
  summary.testsWritten = testRows.length;
  await writeRows(client, testRows, TEST_BODY, quiet, "writing Test nodes");

  // 6. CONTAINS edges — one UNWIND per target label.
  const containsFunctionRows = files.flatMap((f) =>
    f.functions.map((fn) => {
      const fromKey = fileId(f.file.path);
      const toKey = functionId(fn.id);
      return {
        fromId: hashToVertexId(fromKey),
        toId: hashToVertexId(toKey),
        ...edgePair(fromKey, REL_TYPES.CONTAINS, toKey),
      };
    }),
  );
  const containsClassRows = files.flatMap((f) =>
    f.classes.map((c) => {
      const fromKey = fileId(f.file.path);
      const toKey = classId(c.id);
      return {
        fromId: hashToVertexId(fromKey),
        toId: hashToVertexId(toKey),
        ...edgePair(fromKey, REL_TYPES.CONTAINS, toKey),
      };
    }),
  );
  const containsTestRows = files.flatMap((f) =>
    f.tests.map((t) => {
      const fromKey = fileId(f.file.path);
      const toKey = testId(t.id);
      return {
        fromId: hashToVertexId(fromKey),
        toId: hashToVertexId(toKey),
        ...edgePair(fromKey, REL_TYPES.CONTAINS, toKey),
      };
    }),
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

  // 7. IMPORTS edges — File -> Module, matched by id.
  const importsRows = files.flatMap((f) =>
    f.imports.map((imp) => {
      const fromKey = fileId(f.file.path);
      const toKey = moduleId(imp.modulePath);
      return {
        fromId: hashToVertexId(fromKey),
        toId: hashToVertexId(toKey),
        ...edgePair(fromKey, REL_TYPES.IMPORTS, toKey),
      };
    }),
  );
  summary.importsEdges = importsRows.length;
  await writeRows(client, importsRows, IMPORTS_BODY, quiet, "writing IMPORTS edges");

  // 8. METHOD_OF edges — Function -> ClassEntity, matched by id.
  const methodOfRows = files.flatMap((f) =>
    f.methodOf.map((m) => {
      const fromKey = functionId(m.functionId);
      const toKey = classId(m.classId);
      return {
        fromId: hashToVertexId(fromKey),
        toId: hashToVertexId(toKey),
        ...edgePair(fromKey, REL_TYPES.METHOD_OF, toKey),
      };
    }),
  );
  summary.methodOfEdges = methodOfRows.length;
  await writeRows(client, methodOfRows, METHOD_OF_BODY, quiet, "writing METHOD_OF edges");

  // 9. EXTENDS edges — resolve parent names in-memory, then write.
  const { extendsRows: resolvedExtends, extendsUnresolved } = resolveExtends(files);
  const extendsRows = resolvedExtends.map((row) => {
    const fromKey = classId(row.classId as string);
    const toKey = classId(row.parentClassId as string);
    return {
      fromId: hashToVertexId(fromKey),
      toId: hashToVertexId(toKey),
      ...edgePair(fromKey, REL_TYPES.EXTENDS, toKey),
    };
  });
  summary.extendsEdges = extendsRows.length;
  summary.extendsUnresolved = extendsUnresolved;
  await writeRows(client, extendsRows, EXTENDS_BODY, quiet, "writing EXTENDS edges");

  // 10. CALLS edges — resolve callee names in-memory, then write.
  const { callsRows: resolvedCalls, resolved, unresolved, ambiguous } = resolveCalls(files);
  const callsRows = resolvedCalls.map((row) => {
    const fromKey = functionId(row.callerId as string);
    const toKey = functionId(row.calleeId as string);
    return {
      fromId: hashToVertexId(fromKey),
      toId: hashToVertexId(toKey),
      ...edgePair(fromKey, REL_TYPES.CALLS, toKey),
    };
  });
  summary.callsEdgesResolved = resolved;
  summary.callsEdgesUnresolved = unresolved;
  summary.callsEdgesAmbiguous = ambiguous;
  await writeRows(client, callsRows, CALLS_BODY, quiet, "writing CALLS edges");

  // 11. GC — remove stale Function/Class/Test nodes from re-indexed files
  //     (runs after all writes succeed, so current data is never touched).
  summary.staleNodesRemoved = await gcStaleNodes(client, files, quiet);

  return summary;
}
