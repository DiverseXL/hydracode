/**
 * Deterministic string -> vertex id hashing for the graph write pipeline.
 *
 * WHY A HASH: HydraDB's vertex and relationship ids are non-negative
 * integers (u64) — string ids are rejected by the engine
 * (src/client/service.rs `unwind_row_vertex_id`,
 * src/query/opencypher.rs `integer_vertex_id`). Every logical key
 * (e.g. "file:src/cli.ts") is therefore hashed to an integer id at write
 * time. Determinism is what makes re-indexing idempotent: the same logical
 * key always produces the same id, so MERGE updates instead of duplicating.
 *
 * WHY MASK TO 53 BITS (NOT 64): HydraDB transmits ids as plain JSON
 * numbers, i.e. IEEE-754 doubles, and Number.MAX_SAFE_INTEGER is 2^53 - 1.
 * A full 64-bit hash would exceed that range, and the JSON layer would
 * silently round the value — a DIFFERENT number than the one hashed would
 * be sent, with no error, just wrong data. Masking to 53 bits keeps every
 * value exactly representable. 2^53 still gives ~9 quadrillion buckets,
 * more than sufficient for any codebase-scale graph; collisions remain
 * theoretically possible but astronomically unlikely.
 *
 * SCHEMA-MIGRATION HAZARD: this function is part of the on-disk identity
 * of every node. Changing it orphans every existing node in a live graph
 * (re-index would write new ids next to the old ones). Treat any change as
 * a migration; scripts/hash-selftest.ts pins example outputs so a change
 * fails loudly instead of silently.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n; // 64-bit FNV-1a offset basis
const FNV_PRIME = 0x100000001b3n; // 64-bit FNV-1a prime
const MASK_64 = 0xffffffffffffffffn;
const MASK_53 = 0x1fffffffffffffn; // 2^53 - 1 === Number.MAX_SAFE_INTEGER

/** FNV-1a 64-bit hash of `logicalKey`, masked to 53 bits. Deterministic
 *  across runs and processes. */
export function hashToVertexId(logicalKey: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < logicalKey.length; i++) {
    hash ^= BigInt(logicalKey.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return Number(hash & MASK_53);
}
