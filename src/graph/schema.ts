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
} as const;

export type RelType = (typeof REL_TYPES)[keyof typeof REL_TYPES];

/* ------------------------------- Nodes ----------------------------- */

/** A source file in the repo. */
export interface FileNode {
  /** UNIQUE KEY — repo-relative path, e.g. "src/cli.ts". */
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
  /** UNIQUE KEY — resolved module path, e.g. "src/hydra/client.ts" or "zod". */
  path: string;
}

/** A function or method in the code graph. */
export interface FunctionNode {
  /**
   * UNIQUE KEY — `${filePath}#${qualifiedName}#${startLine}`.
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
  /** UNIQUE KEY — `${filePath}#${className}`. */
  id: string;
  name: string;
  exported: boolean;
  startLine: number;
  endLine: number;
}

/** A test case (it/test with a string-literal name and test body). */
export interface TestNode {
  /**
   * UNIQUE KEY — `${filePath}#${testName}#${startLine}`.
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
  /** UNIQUE KEY — e.g. a uuid generated at write time. */
  id: string;
  text: string;
  /** ISO 8601 timestamp of when the fact was created. */
  createdAt: string;
  /** Confidence 0–1; defaults to 1.0 at write time. */
  trust: number;
  status: MemoryFactStatus;
}

/** Union of every node hydracode writes to HydraDB. */
export type AnyGraphNode = CodeGraphNode | MemoryFactNode;
