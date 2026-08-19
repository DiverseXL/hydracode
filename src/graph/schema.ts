/**
 * HydraCode graph schema — the single shared source of truth for the HydraDB
 * graph model.
 *
 * This file maps directly to the hydracode build spec ("Track 02B" code graph
 * + "Track 03" memory graph) and will be consumed by graph/writer.ts (code
 * side) and memory/store.ts (memory side, not yet built). It is deliberately
 * declarative: constants + types only, zero logic, zero HydraDB calls, no
 * Cypher. Cypher generation lives in the writer/store modules.
 *
 * MERGE KEY CONVENTION: every node type below documents exactly one
 * unique-key property. The writer MERGEs on that key, which makes
 * re-indexing idempotent: re-running `hydracode index` updates existing
 * nodes instead of duplicating them.
 *
 * GLOBAL-ID MERGE (confirmed against live HydraDB behavior): HydraDB's
 * row-execution/mutation grammar matches `MERGE (n {id: ...})` on the `id`
 * property ALONE — there is no label filter in the MERGE pattern; the label
 * is attached afterward via `SET n:Label`. The `id` space is therefore
 * GLOBAL across all node types, so uniqueness must hold across types, not
 * just within one. Every unique key below is type-prefixed (`file:`,
 * `module:`, `function:`, `class:`, `test:`, `memory:`) so two conceptually
 * different nodes can never share an id even when their underlying values
 * are identical strings. The motivating collision: a File.path and a
 * Module.path can legitimately be the same repo-relative path (a relative
 * import resolves to the same path as the File node it points to) — under
 * an unprefixed scheme, MERGE would silently fuse the File and the Module
 * into one node.
 *
 * KEY-TO-ID MAPPING (confirmed engine constraint): HydraDB's vertex and
 * relationship ids are non-negative integers (u64) — string ids are
 * rejected (src/client/service.rs `unwind_row_vertex_id`,
 * src/query/opencypher.rs `integer_vertex_id`). The exported key
 * properties below are the LOGICAL KEY (the type-prefixed string). At
 * write time the writer computes the engine id as
 * `id = hashToVertexId(logicalKey)` (graph/hashId.ts — deterministic
 * FNV-1a masked to 53 bits) and ALSO stores the logical key as a `key`
 * property on the node for querying/display/debugging: an integer id alone
 * is not human-readable, so `n.key` is what you query against to find
 * "the file at src/cli.ts". File/Module nodes additionally store an
 * unprefixed display `path` property.
 */

/* ------------------------------------------------------------------ */
/* Code graph (Track 02B)                                              */
/* ------------------------------------------------------------------ */

export type Language = "typescript" | "javascript";

/** Node labels for the code graph. */
export const NODE_LABELS = {
  FILE: "File",
  MODULE: "Module",
  FUNCTION: "Function",
  CLASS: "ClassEntity",
  TEST: "Test",
  /** Memory layer (Track 03) — kept here so one import serves both. */
  MEMORY_FACT: "MemoryFact",
  /** Security analysis findings imported from SARIF. */
  SECURITY_FINDING: "SecurityFinding",
} as const;

export type NodeLabel = (typeof NODE_LABELS)[keyof typeof NODE_LABELS];

/** Relationship types for both graphs. */
export const REL_TYPES = {
  // Code graph
  CONTAINS: "CONTAINS", // File -> Function | ClassEntity | Test
  IMPORTS: "IMPORTS", // File -> Module
  CALLS: "CALLS", // Function -> Function
  EXTENDS: "EXTENDS", // ClassEntity -> ClassEntity
  METHOD_OF: "METHOD_OF", // Function -> ClassEntity
  /**
   * Heuristic, lower-confidence relation: a test can only be reliably linked
   * to what it covers by naming convention / import proximity, not proven
   * statically — treat as best-effort.
   */
  TESTS: "TESTS", // Test -> Function | ClassEntity
  /**
   * Heuristic, lower-confidence relation: config references are detected by
   * pattern (e.g. process.env / config-module imports), not verified
   * statically — treat as best-effort.
   */
  REFERENCES_CONFIG: "REFERENCES_CONFIG", // Function -> Module
  // Memory graph (Track 03)
  SUPERSEDED_BY: "SUPERSEDED_BY", // MemoryFact -> MemoryFact (explicit update: old -> new)
  CONTRADICTS: "CONTRADICTS", // MemoryFact -> MemoryFact (symmetric conflict)
  ABOUT: "ABOUT", // MemoryFact -> Function | ClassEntity | File (optional)
  // Security graph
  AFFECTS: "AFFECTS", // SecurityFinding -> Function | File
} as const;

export type RelType = (typeof REL_TYPES)[keyof typeof REL_TYPES];

/* ------------------------------- Nodes ----------------------------- */

/** A source file in the repo. */
export interface FileNode {
  /**
   * LOGICAL KEY — `file:${path}`, the type-prefixed string that is this
   * node's identity in the global id space (see file header: the space is
   * shared across all node types, so the `file:` prefix is required — a
   * File.path and a Module.path can be the identical string for the same
   * file). At write time the writer stores this value as the node's `key`
   * property, stores the unprefixed display `path` property (e.g.
   * "src/cli.ts"), and computes the engine id as
   * hashToVertexId(this value).
   */
  path: string;
  language: Language;
  /** ISO 8601 timestamp of when this file was last indexed. */
  lastIndexedAt: string;
}

/**
 * A resolved import target. May point at a file inside the repo or at an
 * external module (bare package name, built-in module) that has no File node.
 */
export interface ModuleNode {
  /**
   * LOGICAL KEY — `module:${path}`, the type-prefixed string that is this
   * node's identity in the global id space (see file header). At write time
   * the writer stores this value as the node's `key` property, stores the
   * unprefixed display `path` property (e.g. "src/hydra/client.ts" or
   * "zod"), and computes the engine id as hashToVertexId(this value).
   */
  path: string;
}

/** A function or method in the code graph. */
export interface FunctionNode {
  /**
   * LOGICAL KEY — `function:${filePath}#${qualifiedName}#${startLine}`, the
   * type-prefixed string that is this node's identity in the global id
   * space (see file header: the `function:` prefix is required so a
   * function can never collide with a class/test of the same
   * `file#name#line` string). At write time the writer stores this value as
   * the node's `key` property and computes the engine id as
   * hashToVertexId(this value).
   * startLine disambiguates function overloads (same qualifiedName, same
   * file) and same-named arrow handlers in different scopes. Line numbers
   * are stable within a single indexing pass; re-indexing after an edit
   * yields a new node, which is correct — an edited function is a new fact.
   */
  id: string;
  name: string;
  qualifiedName: string;
  exported: boolean;
  async: boolean;
  startLine: number;
  endLine: number;
}

/** A class declaration (called ClassEntity to avoid clashing with `class`). */
export interface ClassNode {
  /**
   * LOGICAL KEY — `class:${filePath}#${className}`, the type-prefixed
   * string that is this node's identity in the global id space (see file
   * header: the `class:` prefix is required so a class can never collide
   * with a function/test of the same `file#name` string). At write time the
   * writer stores this value as the node's `key` property and computes the
   * engine id as hashToVertexId(this value).
   */
  id: string;
  name: string;
  exported: boolean;
  startLine: number;
  endLine: number;
}

/** A test case (it/test with a string-literal name and test body). */
export interface TestNode {
  /**
   * LOGICAL KEY — `test:${filePath}#${testName}#${startLine}`, the
   * type-prefixed string that is this node's identity in the global id
   * space (see file header: the `test:` prefix is required so a test can
   * never collide with a function/class of the same `file#name#line`
   * string). At write time the writer stores this value as the node's `key`
   * property and computes the engine id as hashToVertexId(this value).
   * startLine disambiguates duplicate test names, which are extremely
   * common (e.g. `it("works")` inside multiple describe blocks).
   */
  id: string;
  name: string;
  filePath: string;
  startLine: number;
}

/** Union of all code-graph nodes. */
export type CodeGraphNode =
  | FileNode
  | ModuleNode
  | FunctionNode
  | ClassNode
  | TestNode;

/* ------------------------------------------------------------------ */
/* Memory graph (Track 03)                                             */
/* ------------------------------------------------------------------ */

export type MemoryFactStatus = "active" | "superseded" | "contradicted";

/** A recorded decision/rationale in the temporal memory layer. */
export interface MemoryFactNode {
  /**
   * LOGICAL KEY — `memory:${uuid}`, the type-prefixed string that is this
   * fact's identity in the global id space (see file header: the `memory:`
   * prefix keeps facts out of the code-graph id space even if a uuid were
   * ever reused or a code node shared the same string). At write time the
   * writer stores this value as the node's `key` property and computes the
   * engine id as hashToVertexId(this value).
   */
  id: string;
  text: string;
  /** ISO 8601 timestamp of when the fact was created. */
  createdAt: string;
  /** Confidence 0–1; defaults to 1.0 at write time. */
  trust: number;
  status: MemoryFactStatus;
}

/** A security finding imported from a SARIF report. */
export interface SecurityFindingNode {
  /**
   * LOGICAL KEY — `finding:${ruleId}#${uri}#${startLine}`, the type-prefixed
   * string that is this finding's identity in the global id space.
   */
  key: string;
  ruleId: string;
  message: string;
  severity: "error" | "warning" | "note" | "none";
  uri: string;
  startLine: number;
  endLine: number;
  tool: string;
}

/**
 * AFFECTS edges link a SecurityFinding to the Function node whose line
 * range contains the finding's startLine (if one exists in the graph),
 * AND always to the File node for the finding's uri (file-level link
 * as fallback when no Function contains the line).
 */

/** Union of every node hydracode writes to HydraDB. */
export type AnyGraphNode = CodeGraphNode | MemoryFactNode | SecurityFindingNode;
